import type { VirtualComputer, ExecOptions, CommandResult } from "./computer.js";

/**
 * Minimal subset of the ssh2 Channel interface used by SshComputer / SshFs.
 * Avoids a hard import of ssh2 at the module level.
 */
export interface SshChannel {
  on(event: string, listener: (...args: any[]) => void): SshChannel;
  stderr: { on(event: string, listener: (...args: any[]) => void): unknown };
  destroy?(): void;
}

/**
 * Minimal subset of the ssh2 SFTPWrapper interface used by SshFs.
 */
export interface SshSftpSession {
  readFile(
    path: string,
    callback: (err: Error | undefined, data: Buffer) => void,
  ): void;
  readFile(
    path: string,
    opts: { encoding: string },
    callback: (err: Error | undefined, data: string) => void,
  ): void;
  writeFile(
    path: string,
    data: string | Buffer,
    callback: (err: Error | undefined) => void,
  ): void;
  appendFile(
    path: string,
    data: string | Buffer,
    callback: (err: Error | undefined) => void,
  ): void;
  unlink(path: string, callback: (err: Error | undefined) => void): void;
  rmdir(path: string, callback: (err: Error | undefined) => void): void;
  mkdir(path: string, callback: (err: Error | undefined) => void): void;
  readdir(
    path: string,
    callback: (
      err: Error | undefined,
      list: Array<{
        filename: string;
        longname: string;
        attrs: { size: number; isDirectory(): boolean; isFile(): boolean; mtime: number; atime: number };
      }>,
    ) => void,
  ): void;
  stat(
    path: string,
    callback: (
      err: Error | undefined,
      stats: { size: number; isDirectory(): boolean; isFile(): boolean; mtime: number; atime: number },
    ) => void,
  ): void;
  open(
    path: string,
    flags: string,
    callback: (err: Error | undefined, handle: Buffer) => void,
  ): void;
  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | undefined, bytesRead: number, buf: Buffer) => void,
  ): void;
  close(handle: Buffer, callback: (err: Error | undefined) => void): void;
  end(): void;
}

/**
 * Minimal subset of the ssh2 Client interface used by SshComputer and SshFs.
 * Avoids a hard import of ssh2 at the module level.
 */
export interface SshClient {
  exec(
    command: string,
    callback: (err: Error | undefined, channel: SshChannel) => void,
  ): void;
  exec(
    command: string,
    opts: Record<string, unknown>,
    callback: (err: Error | undefined, channel: SshChannel) => void,
  ): void;
  sftp(
    callback: (err: Error | undefined, sftp: SshSftpSession) => void,
  ): void;
  end(): void;
  on(event: string, listener: (...args: any[]) => void): this;
}

export interface SshComputerOptions {
  /** A connected ssh2 Client instance. */
  client: SshClient;
  /** Default working directory for commands (default: /). */
  defaultCwd?: string;
  /** Default timeout in ms for commands (default: 30000). */
  defaultTimeout?: number;
}

/**
 * VirtualComputer backed by command execution over SSH.
 *
 * Requires `ssh2` as an optional peer dependency.
 * The caller is responsible for the Client lifecycle (connect, end).
 */
export class SshComputer implements VirtualComputer {
  private client: SshClient;
  private defaultCwd: string;
  private defaultTimeout: number;

  constructor(opts: SshComputerOptions) {
    this.client = opts.client;
    this.defaultCwd = opts.defaultCwd ?? "/";
    this.defaultTimeout = opts.defaultTimeout ?? 30_000;
  }

  async executeCommand(
    command: string,
    opts?: ExecOptions,
  ): Promise<CommandResult> {
    const cwd = opts?.cwd ?? this.defaultCwd;
    const timeout = opts?.timeout ?? this.defaultTimeout;

    let envPrefix = "";
    if (opts?.env) {
      envPrefix = Object.entries(opts.env)
        .map(([k, v]) => `${k}=${shellEscape(v)}`)
        .join(" ") + " ";
    }

    const fullCommand = `cd ${shellEscape(cwd)} && ${envPrefix}${command}`;

    return new Promise<CommandResult>((resolve, reject) => {
      this.client.exec(fullCommand, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }

        const stdoutBufs: Buffer[] = [];
        const stderrBufs: Buffer[] = [];

        const timer = setTimeout(() => {
          channel.destroy?.();
          resolve({
            exitCode: 1,
            stdout: Buffer.concat(stdoutBufs).toString("utf-8"),
            stderr:
              Buffer.concat(stderrBufs).toString("utf-8") +
              "\n[timeout after " + timeout + "ms]",
          });
        }, timeout);

        channel.on("data", (chunk: Buffer) => {
          stdoutBufs.push(Buffer.from(chunk));
        });

        channel.stderr.on("data", (chunk: Buffer) => {
          stderrBufs.push(Buffer.from(chunk));
        });

        channel.on("close", (code: number) => {
          clearTimeout(timer);
          resolve({
            exitCode: code ?? 0,
            stdout: Buffer.concat(stdoutBufs).toString("utf-8"),
            stderr: Buffer.concat(stderrBufs).toString("utf-8"),
          });
        });

        channel.on("error", (channelErr: Error) => {
          clearTimeout(timer);
          reject(channelErr);
        });
      });
    });
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
