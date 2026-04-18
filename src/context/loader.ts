import type { VirtualFs } from "../virtual/fs.js";
import type { ContextFile, ContextScope, ProjectContextConfig } from "./types.js";
import { parseFrontmatter, parsePaths } from "../skills/frontmatter.js";
import { DEFAULT_DOT_DIRS, type DotDirConfig } from "../config/dot-dirs.js";

const DEFAULT_MAX_INCLUDE_DEPTH = 5;

interface NameSet {
  /** e.g. "NOUMEN.md" — loaded from the project root and dot-dir root. */
  md: string;
  /** e.g. "NOUMEN.local.md" — loaded from project root for local overrides. */
  localMd: string;
  /** The dot-dir name, e.g. ".noumen". */
  dotDir: string;
}

/**
 * Derive `<NAME>.md`, `<NAME>.local.md`, and dot-dir from a config entry.
 * `.noumen` → NOUMEN.md, `.claude` → CLAUDE.md, `.foo-bar` → FOO-BAR.md.
 */
function deriveNameSet(dotDirName: string): NameSet {
  const stem = dotDirName.replace(/^\./, "").toUpperCase();
  return {
    md: `${stem}.md`,
    localMd: `${stem}.local.md`,
    dotDir: dotDirName,
  };
}

function resolveNameSets(dotDirs: DotDirConfig | undefined): NameSet[] {
  const names = (dotDirs ?? DEFAULT_DOT_DIRS).names;
  return names.map(deriveNameSet);
}

/**
 * Load project context files from the hierarchical `<NAME>.md` convention.
 * Returns files ordered lowest-to-highest priority:
 * managed -> user -> project (root first, cwd last) -> local.
 *
 * Within each layer, dot-dirs are iterated in config order — so with the
 * default `['.noumen', '.claude']`, `.noumen` content is loaded first
 * (lower precedence within the layer) and `.claude` last (higher
 * precedence within the layer). That matches the historical behavior.
 */
export async function loadProjectContext(
  fs: VirtualFs,
  config: ProjectContextConfig,
): Promise<ContextFile[]> {
  const maxDepth = config.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH;
  const nameSets = resolveNameSets(config.dotDirs);

  const excludes = config.excludes ?? [];
  const files: ContextFile[] = [];

  // 1. Managed layer
  if (config.managedDir) {
    for (const ns of nameSets) {
      await tryLoadFile(fs, join(config.managedDir, ns.md), "managed", files, maxDepth, excludes);
      await scanRulesDir(fs, join(config.managedDir, ns.dotDir, "rules"), "managed", files, maxDepth, excludes);
    }
  }

  // 2. User layer
  if ((config.loadUserContext ?? true) && config.homeDir) {
    for (const ns of nameSets) {
      await tryLoadFile(fs, join(config.homeDir, ns.dotDir, ns.md), "user", files, maxDepth, excludes);
      await scanRulesDir(fs, join(config.homeDir, ns.dotDir, "rules"), "user", files, maxDepth, excludes);
    }
  }

  // 3. Project walk (root -> cwd for ascending priority)
  const dirs = walkAncestors(config.cwd);

  if (config.loadProjectContext ?? true) {
    for (const dir of dirs) {
      for (const ns of nameSets) {
        await tryLoadFile(fs, join(dir, ns.md), "project", files, maxDepth, excludes);
        await tryLoadFile(fs, join(dir, ns.dotDir, ns.md), "project", files, maxDepth, excludes);
        await scanRulesDir(fs, join(dir, ns.dotDir, "rules"), "project", files, maxDepth, excludes);
      }
    }
  }

  // 4. Local layer (same walk order)
  if (config.loadLocalContext ?? true) {
    for (const dir of dirs) {
      for (const ns of nameSets) {
        await tryLoadFile(fs, join(dir, ns.localMd), "local", files, maxDepth, excludes);
      }
    }
  }

  return files;
}

/**
 * Walk from filesystem root down to cwd (root first = lowest priority).
 */
function walkAncestors(cwd: string): string[] {
  const normalized = cwd.endsWith("/") && cwd.length > 1 ? cwd.slice(0, -1) : cwd;
  const parts = normalized.split("/");
  const dirs: string[] = [];

  // Build paths from root toward cwd
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join("/") || "/";
    dirs.push(dir);
  }

  return dirs;
}

async function tryLoadFile(
  fs: VirtualFs,
  path: string,
  scope: ContextScope,
  out: ContextFile[],
  maxDepth: number,
  excludes: string[],
): Promise<void> {
  if (isExcluded(path, excludes)) return;
  const file = await loadContextFile(fs, path, scope, new Set(), 0, maxDepth);
  if (file) out.push(file);
}

async function loadContextFile(
  fs: VirtualFs,
  path: string,
  scope: ContextScope,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
): Promise<ContextFile | null> {
  const normalized = normalizePath(path);
  if (visited.has(normalized)) return null;

  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch {
    return null;
  }

  if (!raw.trim()) return null;

  visited.add(normalized);

  const { frontmatter, body } = parseFrontmatter(raw);
  const globs = parsePaths(frontmatter.paths);
  const content = stripHtmlComments(body);

  const includes = await resolveIncludes(fs, content, path, visited, depth, maxDepth);

  return {
    path,
    scope,
    content,
    ...(globs.length > 0 ? { globs } : {}),
    ...(includes.length > 0 ? { includes } : {}),
  };
}

/**
 * Parse inline `@path` references from markdown content, skipping fenced
 * code blocks and inline code spans. Resolve each path relative to the
 * directory of the including file.
 */
async function resolveIncludes(
  fs: VirtualFs,
  content: string,
  basePath: string,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
): Promise<ContextFile[]> {
  if (depth >= maxDepth) return [];

  const baseDir = dirname(basePath);
  const refs = extractAtReferences(content);
  const includes: ContextFile[] = [];

  for (const ref of refs) {
    const resolved = resolvePath(baseDir, ref);
    const file = await loadContextFile(fs, resolved, "project", visited, depth + 1, maxDepth);
    if (file) includes.push(file);
  }

  return includes;
}

/**
 * Extract `@path` references from markdown text, ignoring references
 * inside fenced code blocks and inline code spans.
 */
function extractAtReferences(content: string): string[] {
  const refs: string[] = [];
  const lines = content.split("\n");
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Strip inline code spans before scanning for @
    const stripped = line.replace(/`[^`]+`/g, "");

    const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const raw = m[1].replace(/\\ /g, " ").replace(/#.*$/, "");
      if (!raw) continue;

      if (raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("~/") || raw.startsWith("/")) {
        refs.push(raw);
      } else if (/^[a-zA-Z0-9._-]/.test(raw) && !raw.startsWith("@")) {
        refs.push(raw);
      }
    }
  }

  return refs;
}

/**
 * Recursively scan a rules directory for *.md files.
 */
async function scanRulesDir(
  fs: VirtualFs,
  dirPath: string,
  scope: ContextScope,
  out: ContextFile[],
  maxDepth: number,
  excludes: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      if (isExcluded(entry.path, excludes)) continue;
      const file = await loadContextFile(fs, entry.path, scope, new Set(), 0, maxDepth);
      if (file) out.push(file);
    } else if (entry.isDirectory) {
      await scanRulesDir(fs, entry.path, scope, out, maxDepth, excludes);
    }
  }
}

/**
 * Strip block-level HTML comments from markdown content.
 */
function stripHtmlComments(content: string): string {
  if (!content.includes("<!--")) return content;
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

function isExcluded(path: string, excludes: string[]): boolean {
  if (excludes.length === 0) return false;
  return excludes.some((pattern) => {
    if (path === pattern) return true;
    if (pattern.includes("*")) {
      const regex = simpleGlobToRegex(pattern);
      return regex.test(path);
    }
    return path.includes(pattern);
  });
}

function simpleGlobToRegex(glob: string): RegExp {
  let result = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        result += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        result += "[^/]*";
      }
    } else if (ch === "?") {
      result += "[^/]";
    } else {
      result += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(result);
}

function normalizePath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      stack.pop();
    } else if (part !== ".") {
      stack.push(part);
    }
  }
  return "/" + stack.join("/");
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx);
}

function join(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

function resolvePath(base: string, relative: string): string {
  if (relative.startsWith("/")) return normalizePath(relative);
  return normalizePath(base + "/" + relative);
}

/**
 * Filter context files to only those whose globs match at least one
 * of the given file paths. Files without globs (unconditional) always pass.
 */
export function filterActiveContextFiles(
  files: ContextFile[],
  touchedPaths: string[],
  cwd: string,
): ContextFile[] {
  return files.filter((f) => {
    if (!f.globs || f.globs.length === 0) return true;
    return touchedPaths.some((filePath) => {
      const relative = filePath.startsWith(cwd)
        ? filePath.slice(cwd.endsWith("/") ? cwd.length : cwd.length + 1)
        : filePath;
      return f.globs!.some((g) => simpleGlobToRegex(g).test(relative));
    });
  });
}

/**
 * Check which conditional context files are newly activated by the given
 * touched paths. Returns the paths of newly activated files.
 */
export function activateContextForPaths(
  allFiles: ContextFile[],
  touchedPaths: string[],
  cwd: string,
  alreadyActivated: Set<string>,
): string[] {
  const activated: string[] = [];

  for (const file of allFiles) {
    if (!file.globs || file.globs.length === 0) continue;
    if (alreadyActivated.has(file.path)) continue;

    for (const filePath of touchedPaths) {
      const relative = filePath.startsWith(cwd)
        ? filePath.slice(cwd.endsWith("/") ? cwd.length : cwd.length + 1)
        : filePath;

      if (file.globs.some((g) => simpleGlobToRegex(g).test(relative))) {
        alreadyActivated.add(file.path);
        activated.push(file.path);
        break;
      }
    }
  }

  return activated;
}
