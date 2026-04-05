import * as path from "node:path";
import type { VirtualFs, FileEntry, FileStat, ReadOptions } from "./fs.js";
import type { DockerContainer } from "./docker-computer.js";

export interface DockerFsOptions {
  /** A dockerode Container instance for the target container. */
  container: DockerContainer;
  /** Working directory for relative path resolution (default: /). */
  workingDir?: string;
}

/**
 * VirtualFs backed by file operations inside a Docker container.
 *
 * Uses `container.exec()` to run filesystem commands (cat, tee, rm, mkdir,
 * stat, etc.) inside the container. File writes use exec + tee to avoid
 * tar archive overhead for text content.
 *
 * Requires `dockerode` as an optional peer dependency.
 * The user is responsible for container lifecycle.
 */
export class DockerFs implements VirtualFs {
  private container: DockerContainer;
  private workingDir: string;

  constructor(opts: DockerFsOptions) {
    this.container = opts.container;
    this.workingDir = opts.workingDir ?? "/";
  }

  private resolvePath(p: string): string {
    if (p.startsWith("/")) return p;
    const resolved = path.resolve(this.workingDir, p);
    const normalizedBase = this.workingDir.endsWith("/") ? this.workingDir : this.workingDir + "/";
    if (resolved !== this.workingDir && !resolved.startsWith(normalizedBase)) {
      throw new Error(`Path "${p}" escapes working directory "${this.workingDir}"`);
    }
    return resolved;
  }

  private async exec(
    cmd: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const execInstance = await this.container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await execInstance.start({ hijack: true, stdin: false });
    const result = await collectExecStream(stream);
    const inspection = await execInstance.inspect();
    return { exitCode: inspection.ExitCode, ...result };
  }

  async readFile(path: string, _opts?: ReadOptions): Promise<string> {
    const resolved = this.resolvePath(path);
    const { exitCode, stdout, stderr } = await this.exec([
      "cat",
      resolved,
    ]);
    if (exitCode !== 0) {
      throw new Error(`DockerFs readFile failed: ${stderr.trim() || `exit code ${exitCode}`}`);
    }
    return stdout;
  }

  async readFileBytes(path: string, maxBytes?: number): Promise<Buffer> {
    const resolved = this.resolvePath(path);
    const cmd = maxBytes !== undefined
      ? ["head", "-c", String(maxBytes), resolved]
      : ["cat", resolved];
    const { exitCode, stdout, stderr } = await this.exec([
      "bash", "-c",
      `${cmd.map(shellEscape).join(" ")} | base64`,
    ]);
    if (exitCode !== 0) {
      throw new Error(`DockerFs readFileBytes failed: ${stderr.trim() || `exit code ${exitCode}`}`);
    }
    return Buffer.from(stdout.trim(), "base64");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const resolved = this.resolvePath(path);
    const dir = resolved.substring(0, resolved.lastIndexOf("/"));
    if (dir) {
      await this.exec(["mkdir", "-p", dir]);
    }

    const encoded = Buffer.from(content, "utf-8").toString("base64");

    const MAX_INLINE_LEN = 100_000;
    if (encoded.length <= MAX_INLINE_LEN) {
      const { exitCode, stderr } = await this.exec([
        "bash",
        "-c",
        `echo ${shellEscape(encoded)} | base64 -d > ${shellEscape(resolved)}`,
      ]);
      if (exitCode !== 0) {
        throw new Error(`DockerFs writeFile failed: ${stderr.trim()}`);
      }
    } else {
      const execInstance = await this.container.exec({
        Cmd: ["bash", "-c", `base64 -d > ${shellEscape(resolved)}`],
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: true,
        Tty: false,
      });
      const stream = await execInstance.start({ hijack: true, stdin: true });
      const writable = stream as unknown as NodeJS.WritableStream;
      writable.write(encoded);
      writable.end();
      const result = await collectExecStream(stream as unknown as NodeJS.ReadableStream);
      const inspection = await execInstance.inspect();
      if (inspection.ExitCode !== 0) {
        throw new Error(`DockerFs writeFile failed: ${result.stderr.trim()}`);
      }
    }
  }

  async appendFile(path: string, content: string): Promise<void> {
    const resolved = this.resolvePath(path);
    const dir = resolved.substring(0, resolved.lastIndexOf("/"));
    if (dir) {
      await this.exec(["mkdir", "-p", dir]);
    }
    const encoded = Buffer.from(content, "utf-8").toString("base64");
    const { exitCode, stderr } = await this.exec([
      "bash",
      "-c",
      `echo ${shellEscape(encoded)} | base64 -d >> ${shellEscape(resolved)}`,
    ]);
    if (exitCode !== 0) {
      throw new Error(`DockerFs appendFile failed: ${stderr.trim()}`);
    }
  }

  async deleteFile(
    path: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const resolved = this.resolvePath(path);
    const args = opts?.recursive ? ["rm", "-rf", resolved] : ["rm", "-f", resolved];
    await this.exec(args);
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const resolved = this.resolvePath(path);
    const args = opts?.recursive
      ? ["mkdir", "-p", resolved]
      : ["mkdir", resolved];
    await this.exec(args);
  }

  async readdir(
    path: string,
    _opts?: { recursive?: boolean },
  ): Promise<FileEntry[]> {
    const resolved = this.resolvePath(path);
    const { exitCode, stdout, stderr } = await this.exec([
      "bash",
      "-c",
      `find ${shellEscape(resolved)} -maxdepth 1 -mindepth 1 -printf '%y %p\\n' 2>/dev/null`,
    ]);
    if (exitCode !== 0 && stderr.trim()) {
      throw new Error(`DockerFs readdir failed: ${stderr.trim()}`);
    }

    const entries: FileEntry[] = [];
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const spaceIdx = line.indexOf(" ");
      const type = line.substring(0, spaceIdx);
      const fullPath = line.substring(spaceIdx + 1);
      const name = fullPath.substring(fullPath.lastIndexOf("/") + 1);
      entries.push({
        name,
        path: fullPath,
        isDirectory: type === "d",
        isFile: type === "f",
      });
    }
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.resolvePath(path);
    const { exitCode } = await this.exec(["test", "-e", resolved]);
    return exitCode === 0;
  }

  async stat(path: string): Promise<FileStat> {
    const resolved = this.resolvePath(path);
    const { exitCode, stdout, stderr } = await this.exec([
      "stat",
      "-c",
      "%s\t%F\t%W\t%Y",
      resolved,
    ]);
    if (exitCode !== 0) {
      throw new Error(`DockerFs stat failed: ${stderr.trim() || `exit code ${exitCode}`}`);
    }

    const parts = stdout.trim().split("\t");
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

function collectExecStream(
  stream: NodeJS.ReadableStream,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    let pending: Buffer = Buffer.alloc(0);

    stream.on("data", (chunk: Buffer) => {
      let buf = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (offset + 8 <= buf.length) {
        const payloadLen = buf.readUInt32BE(offset + 4);
        if (offset + 8 + payloadLen > buf.length) break;
        const streamType = buf[offset];
        const payload = buf.subarray(offset + 8, offset + 8 + payloadLen);
        if (streamType === 2) {
          stderrBufs.push(payload);
        } else {
          stdoutBufs.push(payload);
        }
        offset += 8 + payloadLen;
      }
      pending = offset < buf.length ? buf.subarray(offset) : Buffer.alloc(0);
    });

    stream.on("end", () => {
      resolve({
        stdout: Buffer.concat(stdoutBufs).toString("utf-8"),
        stderr: Buffer.concat(stderrBufs).toString("utf-8"),
      });
    });

    stream.on("error", (err: Error) => reject(err));
  });
}
