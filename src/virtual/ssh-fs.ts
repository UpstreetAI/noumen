import * as pathMod from "node:path";
import type { VirtualFs, FileEntry, FileStat, ReadOptions } from "./fs.js";
import type { SshClient, SshSftpSession } from "./ssh-computer.js";

export interface SshFsOptions {
  /** A connected ssh2 Client instance. */
  client: SshClient;
  /** Working directory for relative path resolution (default: /). */
  workingDir?: string;
}

/**
 * VirtualFs backed by SFTP file operations over SSH.
 *
 * Uses the ssh2 Client's SFTP subsystem for all file I/O. The SFTP session
 * is opened lazily on the first operation and reused for the lifetime of
 * the SshFs instance.
 *
 * Requires `ssh2` as an optional peer dependency.
 * The caller is responsible for the Client lifecycle.
 */
export class SshFs implements VirtualFs {
  private client: SshClient;
  private workingDir: string;
  private sftpSession: SshSftpSession | null = null;
  private sftpPromise: Promise<SshSftpSession> | null = null;

  constructor(opts: SshFsOptions) {
    this.client = opts.client;
    this.workingDir = opts.workingDir ?? "/";
  }

  private getSftp(): Promise<SshSftpSession> {
    if (this.sftpSession) return Promise.resolve(this.sftpSession);
    if (this.sftpPromise) return this.sftpPromise;
    this.sftpPromise = new Promise<SshSftpSession>((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          this.sftpPromise = null;
          reject(err);
        } else {
          this.sftpSession = sftp;
          resolve(sftp);
        }
      });
    });
    return this.sftpPromise;
  }

  private resolvePath(p: string): string {
    if (p.includes("\0")) {
      throw new Error("Path contains null bytes");
    }
    const normalizedBase = this.workingDir.endsWith("/")
      ? this.workingDir
      : this.workingDir + "/";
    if (p.startsWith("/")) {
      const normalized = pathMod.normalize(p);
      if (
        normalized !== this.workingDir &&
        !normalized.startsWith(normalizedBase)
      ) {
        throw new Error(
          `Absolute path "${p}" is outside working directory "${this.workingDir}"`,
        );
      }
      return normalized;
    }
    const resolved = pathMod.resolve(this.workingDir, p);
    if (
      resolved !== this.workingDir &&
      !resolved.startsWith(normalizedBase)
    ) {
      throw new Error(
        `Path "${p}" escapes working directory "${this.workingDir}"`,
      );
    }
    return resolved;
  }

  async readFile(path: string, _opts?: ReadOptions): Promise<string> {
    const resolved = this.resolvePath(path);
    const sftp = await this.getSftp();
    return new Promise<string>((resolve, reject) => {
      sftp.readFile(resolved, { encoding: "utf8" }, (err, data) => {
        if (err) reject(new Error(`SshFs readFile failed: ${err.message}`));
        else resolve(data as string);
      });
    });
  }

  async readFileBytes(path: string, maxBytes?: number): Promise<Buffer> {
    const resolved = this.resolvePath(path);
    const sftp = await this.getSftp();

    if (maxBytes === undefined) {
      return new Promise<Buffer>((resolve, reject) => {
        sftp.readFile(resolved, (err, data) => {
          if (err) reject(new Error(`SshFs readFileBytes failed: ${err.message}`));
          else resolve(data);
        });
      });
    }

    return new Promise<Buffer>((resolve, reject) => {
      sftp.open(resolved, "r", (err, handle) => {
        if (err) {
          reject(new Error(`SshFs readFileBytes failed: ${err.message}`));
          return;
        }
        const buf = Buffer.alloc(maxBytes);
        sftp.read(handle, buf, 0, maxBytes, 0, (readErr, bytesRead, readBuf) => {
          sftp.close(handle, () => {});
          if (readErr) {
            reject(new Error(`SshFs readFileBytes failed: ${readErr.message}`));
          } else {
            resolve(readBuf.subarray(0, bytesRead));
          }
        });
      });
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    const resolved = this.resolvePath(path);
    const sftp = await this.getSftp();
    const dir = pathMod.dirname(resolved);
    await this.mkdirRecursive(sftp, dir);
    return new Promise<void>((resolve, reject) => {
      sftp.writeFile(resolved, content, (err) => {
        if (err) reject(new Error(`SshFs writeFile failed: ${err.message}`));
        else resolve();
      });
    });
  }

  async appendFile(path: string, content: string): Promise<void> {
    const resolved = this.resolvePath(path);
    const sftp = await this.getSftp();
    const dir = pathMod.dirname(resolved);
    await this.mkdirRecursive(sftp, dir);
    return new Promise<void>((resolve, reject) => {
      sftp.appendFile(resolved, content, (err) => {
        if (err) reject(new Error(`SshFs appendFile failed: ${err.message}`));
        else resolve();
      });
    });
  }

  async deleteFile(
    path: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const resolved = this.resolvePath(path);
    if (opts?.recursive) {
      const sftp = await this.getSftp();
      await this.rmRecursive(sftp, resolved);
      return;
    }
    const sftp = await this.getSftp();
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(resolved, (err) => {
        if (err) reject(new Error(`SshFs deleteFile failed: ${err.message}`));
        else resolve();
      });
    });
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const resolved = this.resolvePath(path);
    const sftp = await this.getSftp();
    if (opts?.recursive) {
      await this.mkdirRecursive(sftp, resolved);
      return;
    }
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(resolved, (err) => {
        if (err) reject(new Error(`SshFs mkdir failed: ${err.message}`));
        else resolve();
      });
    });
  }

  async readdir(
    path: string,
    _opts?: { recursive?: boolean },
  ): Promise<FileEntry[]> {
    const resolved = this.resolvePath(path);
    const sftp = await this.getSftp();
    return new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(resolved, (err, list) => {
        if (err) {
          reject(new Error(`SshFs readdir failed: ${err.message}`));
          return;
        }
        const entries: FileEntry[] = list.map((item) => ({
          name: item.filename,
          path: pathMod.join(resolved, item.filename),
          isDirectory: item.attrs.isDirectory(),
          isFile: item.attrs.isFile(),
        }));
        resolve(entries);
      });
    });
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.resolvePath(path);
    const sftp = await this.getSftp();
    return new Promise<boolean>((resolve) => {
      sftp.stat(resolved, (err) => {
        resolve(!err);
      });
    });
  }

  async stat(path: string): Promise<FileStat> {
    const resolved = this.resolvePath(path);
    const sftp = await this.getSftp();
    return new Promise<FileStat>((resolve, reject) => {
      sftp.stat(resolved, (err, stats) => {
        if (err) {
          reject(new Error(`SshFs stat failed: ${err.message}`));
          return;
        }
        resolve({
          size: stats.size,
          isDirectory: stats.isDirectory(),
          isFile: stats.isFile(),
          modifiedAt: stats.mtime > 0 ? new Date(stats.mtime * 1000) : undefined,
        });
      });
    });
  }

  private async mkdirRecursive(
    sftp: SshSftpSession,
    dir: string,
  ): Promise<void> {
    const parts = dir.split("/").filter(Boolean);
    let current = "/";
    for (const part of parts) {
      current = pathMod.join(current, part);
      await new Promise<void>((resolve) => {
        sftp.mkdir(current, () => {
          resolve();
        });
      });
    }
  }

  private async rmRecursive(
    sftp: SshSftpSession,
    target: string,
  ): Promise<void> {
    const isDir = await new Promise<boolean>((resolve) => {
      sftp.stat(target, (err, stats) => {
        if (err) resolve(false);
        else resolve(stats.isDirectory());
      });
    });

    if (!isDir) {
      return new Promise<void>((resolve, reject) => {
        sftp.unlink(target, (err) => {
          if (err) reject(new Error(`SshFs deleteFile failed: ${err.message}`));
          else resolve();
        });
      });
    }

    const entries = await new Promise<Array<{ filename: string; attrs: { isDirectory(): boolean } }>>(
      (resolve, reject) => {
        sftp.readdir(target, (err, list) => {
          if (err) reject(new Error(`SshFs deleteFile failed: ${err.message}`));
          else resolve(list);
        });
      },
    );

    for (const entry of entries) {
      await this.rmRecursive(sftp, pathMod.join(target, entry.filename));
    }

    return new Promise<void>((resolve, reject) => {
      sftp.rmdir(target, (err) => {
        if (err) reject(new Error(`SshFs deleteFile failed: ${err.message}`));
        else resolve();
      });
    });
  }
}
