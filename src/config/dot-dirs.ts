import type { VirtualFs } from "../virtual/fs.js";

/**
 * Configuration for which dot-directory names the agent recognizes when
 * reading and writing auxiliary state (context files, skills, sessions,
 * tasks, checkpoints, CLI config, MCP auth tokens, etc).
 *
 * The list is ordered by preference:
 *  - `names[0]` is the canonical write target.
 *  - For single-file reads (e.g. `config.json`), callers use first-hit-wins
 *    across candidates in order.
 *  - For additive reads (e.g. rules, skills), every candidate is loaded and
 *    later entries in the list have higher precedence when resolving
 *    collisions (mirrors the context loader's layer ordering).
 *
 * The same list applies to both project scope (cwd ancestors) and user
 * scope (home directory). There is intentionally no per-scope split — if
 * a caller needs that, they can route through different resolvers.
 */
export interface DotDirConfig {
  names: string[];
}

/**
 * Default dot-directory configuration. Recognizes `.noumen` (canonical)
 * and `.claude` (compatibility), preferring `.noumen` for writes.
 */
export const DEFAULT_DOT_DIRS: DotDirConfig = {
  names: [".noumen", ".claude"],
};

/**
 * Pure path resolver over a `DotDirConfig`. Does no I/O — callers pair it
 * with `readFirstDotDir` / `readAllDotDirs` (VirtualFs helpers below) or
 * their own filesystem code.
 */
export interface DotDirResolver {
  /** The underlying configuration (exposed for permissions and logging). */
  config: DotDirConfig;

  /**
   * Absolute paths for each candidate dot-dir under `base`, in preference
   * order (most preferred first). `base` is appended with a `/` separator
   * unless already present.
   */
  candidates(base: string): string[];

  /** The canonical write target (`candidates(base)[0]`). */
  writePath(base: string): string;

  /**
   * Each candidate joined with `rel`, in preference order. Use this for
   * first-hit-wins reads (e.g. `config.json`).
   */
  joinRead(base: string, rel: string): string[];

  /** Write path joined with `rel`. */
  joinWrite(base: string, rel: string): string;
}

function joinPath(base: string, rel: string): string {
  if (!rel) return base;
  // Strip trailing slashes on base (keep root "/" as empty so "/" + "foo" → "/foo").
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedRel = rel.replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedRel}`;
}

export function createDotDirResolver(config: DotDirConfig = DEFAULT_DOT_DIRS): DotDirResolver {
  if (!config.names || config.names.length === 0) {
    throw new Error("DotDirConfig.names must be a non-empty array");
  }

  const names = config.names;

  return {
    config: { names: [...names] },
    candidates(base: string): string[] {
      return names.map((n) => joinPath(base, n));
    },
    writePath(base: string): string {
      return joinPath(base, names[0]);
    },
    joinRead(base: string, rel: string): string[] {
      return names.map((n) => joinPath(joinPath(base, n), rel));
    },
    joinWrite(base: string, rel: string): string {
      return joinPath(joinPath(base, names[0]), rel);
    },
  };
}

/**
 * Read the first file that exists across the resolver's candidate paths
 * under `base/<name>/<rel>`. Returns `null` if none match.
 */
export async function readFirstDotDir(
  fs: VirtualFs,
  resolver: DotDirResolver,
  base: string,
  rel: string,
): Promise<{ path: string; content: string } | null> {
  for (const candidate of resolver.joinRead(base, rel)) {
    try {
      const content = await fs.readFile(candidate);
      return { path: candidate, content };
    } catch {
      // keep walking
    }
  }
  return null;
}

/**
 * Read every candidate file that exists under `base/<name>/<rel>`. Results
 * are ordered from lowest to highest precedence (matching the context
 * loader's layer-stacking convention where later entries win).
 */
export async function readAllDotDirs(
  fs: VirtualFs,
  resolver: DotDirResolver,
  base: string,
  rel: string,
): Promise<Array<{ path: string; content: string }>> {
  const candidates = resolver.joinRead(base, rel);
  const results: Array<{ path: string; content: string }> = [];

  // Walk candidates in reverse so that names[0] (the preferred/write dir)
  // ends up last — i.e. highest precedence for stacking consumers.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    try {
      const content = await fs.readFile(candidate);
      results.push({ path: candidate, content });
    } catch {
      // skip
    }
  }
  return results;
}
