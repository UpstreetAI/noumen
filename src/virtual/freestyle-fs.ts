import * as path from "node:path";
import type { VirtualFs, FileEntry, FileStat, ReadOptions } from "./fs.js";
import type { FreestyleVmInstance } from "./freestyle-computer.js";

export interface FreestyleFsOptions {
  /** A Freestyle VM instance. */
  vm: FreestyleVmInstance;
  /** Working directory for relative path resolution. */
  workingDir?: string;
}

/**
 * VirtualFs backed by a Freestyle VM.
 *
 * Uses `vm.fs.*` for operations with native SDK support (readTextFile,
 * writeTextFile, readDir) and falls back to `vm.exec()` for the rest
 * (stat, exists, mkdir, deleteFile, appendFile, readFileBytes).
 *
 * Requires `freestyle-sandboxes` as an optional peer dependency.
 * The user is responsible for VM lifecycle when using explicit mode.
 */
export class FreestyleFs implements VirtualFs {
  private vm: FreestyleVmInstance;
  private workingDir: string | undefined;

  constructor(opts: FreestyleFsOptions) {
    this.vm = opts.vm;
    this.workingDir = opts.workingDir;
  }

  private resolvePath(p: string): string {
    if (p.includes("\0")) {
      throw new Error("Path contains null bytes");
    }
    if (!this.workingDir) return p;
    const normalizedBase = this.workingDir.endsWith("/") ? this.workingDir : this.workingDir + "/";
    if (p.startsWith("/")) {
      const normalized = path.normalize(p);
      if (normalized !== this.workingDir && !normalized.startsWith(normalizedBase)) {
        throw new Error(`Absolute path "${p}" is outside working directory "${this.workingDir}"`);
      }
      return normalized;
    }
    const resolved = path.resolve(this.workingDir, p);
    if (resolved !== this.workingDir && !resolved.startsWith(normalizedBase)) {
      throw new Error(`Path "${p}" escapes working directory "${this.workingDir}"`);
    }
    return resolved;
  }

  async readFile(filePath: string, _opts?: ReadOptions): Promise<string> {
    return this.vm.fs.readTextFile(this.resolvePath(filePath));
  }

  async readFileBytes(filePath: string, maxBytes?: number): Promise<Buffer> {
    const resolved = this.resolvePath(filePath);
    const cmd = maxBytes !== undefined
      ? `head -c ${maxBytes} ${shellEscape(resolved)} | base64`
      : `base64 ${shellEscape(resolved)}`;
    const { statusCode, stdout, stderr } = await this.vm.exec(cmd);
    if (statusCode !== 0) {
      throw new Error(`FreestyleFs readFileBytes failed: ${stderr?.trim() || `exit code ${statusCode}`}`);
    }
    return Buffer.from((stdout ?? "").trim(), "base64");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.vm.fs.writeTextFile(this.resolvePath(filePath), content);
  }

  async appendFile(filePath: string, content: string): Promise<void> {
    const resolved = this.resolvePath(filePath);
    const encoded = Buffer.from(content, "utf-8").toString("base64");
    const { statusCode, stderr } = await this.vm.exec(
      `echo ${shellEscape(encoded)} | base64 -d >> ${shellEscape(resolved)}`,
    );
    if (statusCode !== 0) {
      throw new Error(`FreestyleFs appendFile failed: ${stderr?.trim() || `exit code ${statusCode}`}`);
    }
  }

  async deleteFile(
    filePath: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const resolved = this.resolvePath(filePath);
    const flag = opts?.recursive ? "-rf" : "-f";
    await this.vm.exec(`rm ${flag} ${shellEscape(resolved)}`);
  }

  async mkdir(filePath: string, opts?: { recursive?: boolean }): Promise<void> {
    const resolved = this.resolvePath(filePath);
    const flag = opts?.recursive ? "-p " : "";
    await this.vm.exec(`mkdir ${flag}${shellEscape(resolved)}`);
  }

  async readdir(
    dirPath: string,
    _opts?: { recursive?: boolean },
  ): Promise<FileEntry[]> {
    const resolved = this.resolvePath(dirPath);
    const items = await this.vm.fs.readDir(resolved);
    return items.map((entry) => ({
      name: entry.name,
      path: resolved === "/" ? `/${entry.name}` : `${resolved}/${entry.name}`,
      isDirectory: entry.kind === "dir" || entry.kind === "directory",
      isFile: entry.kind === "file",
    }));
  }

  async exists(filePath: string): Promise<boolean> {
    const resolved = this.resolvePath(filePath);
    const { statusCode } = await this.vm.exec(`test -e ${shellEscape(resolved)}`);
    return statusCode === 0;
  }

  async stat(filePath: string): Promise<FileStat> {
    const resolved = this.resolvePath(filePath);
    const { statusCode, stdout, stderr } = await this.vm.exec(
      `stat -c '%s\t%F\t%W\t%Y' ${shellEscape(resolved)}`,
    );
    if (statusCode !== 0) {
      throw new Error(`FreestyleFs stat failed: ${stderr?.trim() || `exit code ${statusCode}`}`);
    }

    const parts = (stdout ?? "").trim().split("\t");
    const size = parseInt(parts[0], 10);
    const fileType = parts[1];
    const createdEpoch = parseInt(parts[2], 10);
    const modifiedEpoch = parseInt(parts[3], 10);

    return {
      size,
      isDirectory: fileType === "directory",
      isFile: fileType.startsWith("regular"),
      createdAt: createdEpoch > 0 ? new Date(createdEpoch * 1000) : undefined,
      modifiedAt: modifiedEpoch > 0 ? new Date(modifiedEpoch * 1000) : undefined,
    };
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
