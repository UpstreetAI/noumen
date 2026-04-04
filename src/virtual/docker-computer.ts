import type { VirtualComputer, ExecOptions, CommandResult } from "./computer.js";

/**
 * Minimal subset of the dockerode Container interface used by DockerComputer.
 * Avoids a hard import of dockerode at the module level.
 */
export interface DockerContainer {
  exec(
    options: Record<string, unknown>,
  ): Promise<{ start(opts?: Record<string, unknown>): Promise<NodeJS.ReadableStream>; inspect(): Promise<{ ExitCode: number }> }>;
}

export interface DockerComputerOptions {
  /** A dockerode Container instance for the target container. */
  container: DockerContainer;
  /** Default working directory for commands (default: /). */
  defaultCwd?: string;
  /** Default timeout in ms for commands (default: 30000). */
  defaultTimeout?: number;
}

/**
 * VirtualComputer backed by command execution inside a Docker container.
 *
 * Requires `dockerode` as an optional peer dependency.
 * The user is responsible for container lifecycle (create, start, stop).
 */
export class DockerComputer implements VirtualComputer {
  private container: DockerContainer;
  private defaultCwd: string;
  private defaultTimeout: number;

  constructor(opts: DockerComputerOptions) {
    this.container = opts.container;
    this.defaultCwd = opts.defaultCwd ?? "/";
    this.defaultTimeout = opts.defaultTimeout ?? 30_000;
  }

  async executeCommand(
    command: string,
    opts?: ExecOptions,
  ): Promise<CommandResult> {
    const cwd = opts?.cwd ?? this.defaultCwd;
    const timeout = opts?.timeout ?? this.defaultTimeout;

    const execOpts: Record<string, unknown> = {
      Cmd: ["bash", "-c", `cd ${shellEscape(cwd)} && ${command}`],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    };
    if (opts?.env) {
      execOpts.Env = Object.entries(opts.env).map(
        ([k, v]) => `${k}=${v}`,
      );
    }

    const exec = await this.container.exec(execOpts);
    const stream = await exec.start({ hijack: true, stdin: false });

    const { stdout, stderr } = await collectStream(stream, timeout);
    const inspection = await exec.inspect();

    return {
      exitCode: inspection.ExitCode,
      stdout,
      stderr,
    };
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function collectStream(
  stream: NodeJS.ReadableStream,
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];

    const timer = setTimeout(() => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      resolve({
        stdout: Buffer.concat(stdoutBufs).toString("utf-8"),
        stderr: Buffer.concat(stderrBufs).toString("utf-8") +
          "\n[timeout after " + timeout + "ms]",
      });
    }, timeout);

    stream.on("data", (chunk: Buffer) => {
      // Docker multiplexed stream: first 8 bytes are header
      // byte 0: stream type (1=stdout, 2=stderr)
      // bytes 4-7: payload length (big-endian uint32)
      let offset = 0;
      while (offset + 8 <= chunk.length) {
        const streamType = chunk[offset];
        const payloadLen = chunk.readUInt32BE(offset + 4);
        const payload = chunk.subarray(offset + 8, offset + 8 + payloadLen);
        if (streamType === 2) {
          stderrBufs.push(payload);
        } else {
          stdoutBufs.push(payload);
        }
        offset += 8 + payloadLen;
      }
    });

    stream.on("end", () => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutBufs).toString("utf-8"),
        stderr: Buffer.concat(stderrBufs).toString("utf-8"),
      });
    });

    stream.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
