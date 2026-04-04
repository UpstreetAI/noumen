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

  constructor(opts?: LocalFsOptions) {
    this.basePath = opts?.basePath ?? process.cwd();
  }

  private resolve(p: string): string {
    if (path.isAbsolute(p)) return p;
    return path.resolve(this.basePath, p);
  }

  async readFile(filePath: string, opts?: ReadOptions): Promise<string> {
    const encoding = opts?.encoding ?? "utf-8";
    return fs.readFile(this.resolve(filePath), { encoding });
  }

  async readFileBytes(filePath: string, maxBytes?: number): Promise<Buffer> {
    const resolved = this.resolve(filePath);
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
    const resolved = this.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
  }

  async appendFile(filePath: string, content: string): Promise<void> {
    const resolved = this.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.appendFile(resolved, content, "utf-8");
  }

  async deleteFile(
    filePath: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    await fs.rm(this.resolve(filePath), {
      recursive: opts?.recursive ?? false,
      force: true,
    });
  }

  async mkdir(dirPath: string, opts?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(this.resolve(dirPath), {
      recursive: opts?.recursive ?? false,
    });
  }

  async readdir(
    dirPath: string,
    opts?: { recursive?: boolean },
  ): Promise<FileEntry[]> {
    const resolved = this.resolve(dirPath);
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
      await fs.access(this.resolve(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const stats = await fs.stat(this.resolve(filePath));
    return {
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
    };
  }
}
