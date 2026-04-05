import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VirtualFs, FileEntry, FileStat, ReadOptions } from "./fs.js";

export interface LocalFsOptions {
  basePath?: string;
}

/**
 * Unsandboxed VirtualFs backed by `node:fs/promises` on the host machine.
 * Paths resolve relative to `basePath`. Suitable for local development and
 * trusted environments. For production or untrusted agents, use a sandboxed
 * implementation like `SpritesFs` (remote container) or a custom
 * Docker/E2B adapter instead.
 */
export class LocalFs implements VirtualFs {
  private basePath: string;
  private resolvedBasePath: string;
  private realBasePathPromise: Promise<string> | null = null;

  constructor(opts?: LocalFsOptions) {
    this.basePath = opts?.basePath ?? process.cwd();
    this.resolvedBasePath = path.resolve(this.basePath);
  }

  private async getRealBasePath(): Promise<string> {
    if (!this.realBasePathPromise) {
      this.realBasePathPromise = (async () => {
        try {
          return await fs.realpath(this.resolvedBasePath);
        } catch {
          // Base path may not exist yet; resolve its closest existing ancestor.
          const parentReal = await fs.realpath(path.dirname(this.resolvedBasePath)).catch(() => path.dirname(this.resolvedBasePath));
          return path.join(parentReal, path.basename(this.resolvedBasePath));
        }
      })();
    }
    return this.realBasePathPromise;
  }

  private async resolve(p: string): Promise<string> {
    if (p.includes("\0")) {
      throw new Error(`Path contains null bytes`);
    }
    const resolved = path.isAbsolute(p) ? path.normalize(p) : path.resolve(this.basePath, p);
    if (resolved !== this.resolvedBasePath && !resolved.startsWith(this.resolvedBasePath + path.sep)) {
      throw new Error(`Path "${p}" resolves outside base directory "${this.basePath}"`);
    }
    // Resolve symlinks to prevent escaping the base directory via symlink chains.
    // Walk up from the target until we find an existing ancestor, then re-append
    // the non-existent tail so the comparison uses real paths on both sides.
    const realBase = await this.getRealBasePath();
    const realTarget = await realpathWalkUp(resolved);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
      throw new Error(`Path "${p}" resolves outside base directory via symlink`);
    }
    return resolved;
  }

  async readFile(filePath: string, opts?: ReadOptions): Promise<string> {
    const encoding = opts?.encoding ?? "utf-8";
    return fs.readFile(await this.resolve(filePath), { encoding });
  }

  async readFileBytes(filePath: string, maxBytes?: number): Promise<Buffer> {
    const resolved = await this.resolve(filePath);
    if (maxBytes === undefined) {
      return fs.readFile(resolved);
    }
    const fh = await fs.open(resolved, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const resolved = await this.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
  }

  async appendFile(filePath: string, content: string): Promise<void> {
    const resolved = await this.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.appendFile(resolved, content, "utf-8");
  }

  async deleteFile(
    filePath: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    await fs.rm(await this.resolve(filePath), {
      recursive: opts?.recursive ?? false,
      force: true,
    });
  }

  async mkdir(dirPath: string, opts?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(await this.resolve(dirPath), {
      recursive: opts?.recursive ?? false,
    });
  }

  async readdir(
    dirPath: string,
    opts?: { recursive?: boolean },
  ): Promise<FileEntry[]> {
    const resolved = await this.resolve(dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const results: FileEntry[] = [];

    for (const entry of entries) {
      const entryPath = path.join(resolved, entry.name);
      results.push({
        name: entry.name,
        path: entryPath,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      });

      if (opts?.recursive && entry.isDirectory()) {
        const subEntries = await this.readdir(entryPath, { recursive: true });
        results.push(...subEntries);
      }
    }

    return results;
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(await this.resolve(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const stats = await fs.stat(await this.resolve(filePath));
    return {
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
    };
  }
}

/**
 * Resolve symlinks in a path, walking up to the nearest existing ancestor when
 * the path (or intermediate directories) don't exist yet. Non-existent tail
 * segments are appended to the resolved ancestor.
 */
async function realpathWalkUp(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const parent = path.dirname(target);
  if (parent === target) return target;
  const resolvedParent = await realpathWalkUp(parent);
  return path.join(resolvedParent, path.basename(target));
}
