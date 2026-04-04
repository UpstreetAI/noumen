import type { VirtualFs } from "../virtual/fs.js";
import type { MemoryEntry, MemoryProvider, MemoryType } from "./types.js";

const INDEX_NAME = "MEMORY.md";
const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_BYTES = 25_000;

const MEMORY_TYPES: ReadonlySet<string> = new Set([
  "user",
  "project",
  "feedback",
  "reference",
]);

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  type?: MemoryType;
  rest: string;
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return { rest: raw };
  }

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) {
    return { rest: raw };
  }

  const fmBlock = trimmed.slice(3, endIdx).trim();
  const rest = trimmed.slice(endIdx + 3).trim();

  let name: string | undefined;
  let description: string | undefined;
  let type: MemoryType | undefined;

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "name") name = value;
    else if (key === "description") description = value;
    else if (key === "type" && MEMORY_TYPES.has(value)) type = value as MemoryType;
  }

  return { name, description, type, rest };
}

function serializeEntry(entry: MemoryEntry): string {
  const lines = [
    "---",
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    "---",
    "",
    entry.content,
  ];
  return lines.join("\n");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Index truncation (ported from claude-code's truncateEntrypointContent)
// ---------------------------------------------------------------------------

export interface IndexTruncation {
  content: string;
  lineCount: number;
  byteCount: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
}

export function truncateIndex(
  raw: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
): IndexTruncation {
  const trimmed = raw.trim();
  const contentLines = trimmed.split("\n");
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;

  const wasLineTruncated = lineCount > maxLines;
  const wasByteTruncated = byteCount > maxBytes;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, maxLines).join("\n")
    : trimmed;

  if (truncated.length > maxBytes) {
    const cutAt = truncated.lastIndexOf("\n", maxBytes);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : maxBytes);
  }

  const reason = wasByteTruncated && !wasLineTruncated
    ? `${byteCount} bytes (limit: ${maxBytes})`
    : wasLineTruncated && !wasByteTruncated
      ? `${lineCount} lines (limit: ${maxLines})`
      : `${lineCount} lines and ${byteCount} bytes`;

  return {
    content:
      truncated +
      `\n\n> WARNING: ${INDEX_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

// ---------------------------------------------------------------------------
// FileMemoryProvider
// ---------------------------------------------------------------------------

/**
 * Default `MemoryProvider` that stores memories as individual `.md` files
 * with YAML frontmatter, plus a `MEMORY.md` index. All I/O goes through
 * `VirtualFs` so it works with any sandbox backend.
 */
export class FileMemoryProvider implements MemoryProvider {
  private fs: VirtualFs;
  private dir: string;
  private maxIndexLines: number;

  constructor(fs: VirtualFs, memoryDir: string, maxIndexLines = DEFAULT_MAX_LINES) {
    this.fs = fs;
    this.dir = memoryDir.endsWith("/") ? memoryDir : memoryDir + "/";
    this.maxIndexLines = maxIndexLines;
  }

  private indexPath(): string {
    return this.dir + INDEX_NAME;
  }

  private async ensureDir(): Promise<void> {
    const exists = await this.fs.exists(this.dir);
    if (!exists) {
      await this.fs.mkdir(this.dir, { recursive: true });
    }
  }

  async loadIndex(): Promise<string> {
    try {
      const raw = await this.fs.readFile(this.indexPath());
      return truncateIndex(raw, this.maxIndexLines).content;
    } catch {
      return "";
    }
  }

  async loadEntry(path: string): Promise<MemoryEntry | null> {
    const fullPath = path.startsWith(this.dir) ? path : this.dir + path;
    try {
      const raw = await this.fs.readFile(fullPath);
      const fm = parseFrontmatter(raw);
      const stat = await this.fs.stat(fullPath).catch(() => null);
      return {
        name: fm.name ?? pathToName(path),
        description: fm.description ?? "",
        type: fm.type ?? "project",
        content: fm.rest,
        path: path.startsWith(this.dir) ? path.slice(this.dir.length) : path,
        updatedAt: stat?.modifiedAt?.toISOString(),
      };
    } catch {
      return null;
    }
  }

  async saveEntry(entry: MemoryEntry): Promise<void> {
    await this.ensureDir();
    const relativePath = entry.path ?? slugify(entry.name) + ".md";
    const fullPath = this.dir + relativePath;
    const content = serializeEntry({ ...entry, path: relativePath });
    await this.fs.writeFile(fullPath, content);
    await this.rebuildIndex();
  }

  async removeEntry(path: string): Promise<void> {
    const fullPath = path.startsWith(this.dir) ? path : this.dir + path;
    try {
      await this.fs.deleteFile(fullPath);
    } catch {
      // Already gone
    }
    await this.rebuildIndex();
  }

  async listEntries(): Promise<MemoryEntry[]> {
    try {
      const files = await this.fs.readdir(this.dir);
      const entries: MemoryEntry[] = [];
      for (const file of files) {
        if (!file.isFile || !file.name.endsWith(".md") || file.name === INDEX_NAME) continue;
        const entry = await this.loadEntry(file.name);
        if (entry) entries.push(entry);
      }
      return entries;
    } catch {
      return [];
    }
  }

  async search(query: string): Promise<MemoryEntry[]> {
    const entries = await this.listEntries();
    const lower = query.toLowerCase();
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(lower) ||
        e.description.toLowerCase().includes(lower) ||
        e.content.toLowerCase().includes(lower),
    );
  }

  private async rebuildIndex(): Promise<void> {
    const entries = await this.listEntries();
    const lines: string[] = [];
    for (const entry of entries) {
      const relativePath = entry.path ?? slugify(entry.name) + ".md";
      const desc = entry.description ? ` — ${entry.description}` : "";
      lines.push(`- [${entry.name}](${relativePath})${desc}`);
    }
    await this.ensureDir();
    await this.fs.writeFile(this.indexPath(), lines.join("\n") + "\n");
  }
}

function pathToName(p: string): string {
  const base = p.split("/").pop() ?? p;
  return base.replace(/\.md$/i, "").replace(/[_-]/g, " ");
}
