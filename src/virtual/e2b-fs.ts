import * as path from "node:path";
import type { VirtualFs, FileEntry, FileStat, ReadOptions } from "./fs.js";
import type { E2BSandboxInstance } from "./e2b-computer.js";

export interface E2BFsOptions {
  /** An E2B Sandbox instance created via `Sandbox.create()`. */
  sandbox: E2BSandboxInstance;
  /** Working directory for relative path resolution. */
  workingDir?: string;
}

/**
 * VirtualFs backed by the E2B cloud sandbox filesystem.
 *
 * Requires `e2b` as an optional peer dependency.
 * The user is responsible for sandbox lifecycle (create, close).
 */
export class E2BFs implements VirtualFs {
  private sandbox: E2BSandboxInstance;
  private workingDir: string | undefined;

  constructor(opts: E2BFsOptions) {
    this.sandbox = opts.sandbox;
    this.workingDir = opts.workingDir;
  }

  private resolvePath(p: string): string {
    if (p.startsWith("/")) return p;
    if (!this.workingDir) return p;
    const resolved = path.resolve(this.workingDir, p);
    const normalizedBase = this.workingDir.endsWith("/") ? this.workingDir : this.workingDir + "/";
    if (resolved !== this.workingDir && !resolved.startsWith(normalizedBase)) {
      throw new Error(`Path "${p}" escapes working directory "${this.workingDir}"`);
    }
    return resolved;
  }

  async readFile(path: string, _opts?: ReadOptions): Promise<string> {
    return this.sandbox.files.read(this.resolvePath(path), {
      format: "text",
    });
  }

  async readFileBytes(path: string, maxBytes?: number): Promise<Buffer> {
    const data = await this.sandbox.files.read(this.resolvePath(path), {
      format: "bytes",
    } as Record<string, unknown>);
    const buf = Buffer.from(data as unknown as ArrayBuffer);
    if (maxBytes !== undefined && buf.length > maxBytes) {
      return buf.subarray(0, maxBytes);
    }
    return buf;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sandbox.files.write(this.resolvePath(path), content);
  }

  async appendFile(path: string, content: string): Promise<void> {
    let existing = "";
    try {
      existing = await this.readFile(path);
    } catch {
      // file may not exist yet
    }
    await this.writeFile(path, existing + content);
  }

  async deleteFile(
    path: string,
    _opts?: { recursive?: boolean },
  ): Promise<void> {
    await this.sandbox.files.remove(this.resolvePath(path));
  }

  async mkdir(path: string, _opts?: { recursive?: boolean }): Promise<void> {
    await this.sandbox.files.makeDir(this.resolvePath(path));
  }

  async readdir(
    path: string,
    _opts?: { recursive?: boolean },
  ): Promise<FileEntry[]> {
    const entries = await this.sandbox.files.list(this.resolvePath(path));
    return entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.type === "dir",
      isFile: entry.type === "file",
      size: entry.size,
    }));
  }

  async exists(path: string): Promise<boolean> {
    return this.sandbox.files.exists(this.resolvePath(path));
  }

  async stat(path: string): Promise<FileStat> {
    const info = await this.sandbox.files.getInfo(this.resolvePath(path));
    return {
      size: info.size ?? 0,
      isDirectory: info.type === "dir",
      isFile: info.type === "file",
      modifiedAt: info.modifiedTime,
    };
  }
}
