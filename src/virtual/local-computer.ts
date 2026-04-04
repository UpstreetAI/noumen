import { exec as execCb } from "node:child_process";
import type { VirtualComputer, ExecOptions, CommandResult } from "./computer.js";

export interface LocalComputerOptions {
  defaultCwd?: string;
  defaultTimeout?: number;
}

/**
 * Unsandboxed VirtualComputer that runs commands directly on the host via
 * `node:child_process`. Suitable for local development and trusted
 * environments. For production or untrusted agents, use a sandboxed
 * implementation like `SpritesComputer` (remote container) or a custom
 * Docker/E2B adapter instead.
 */
export class LocalComputer implements VirtualComputer {
  private defaultCwd: string;
  private defaultTimeout: number;

  constructor(opts?: LocalComputerOptions) {
    this.defaultCwd = opts?.defaultCwd ?? process.cwd();
    this.defaultTimeout = opts?.defaultTimeout ?? 30_000;
  }

  executeCommand(command: string, opts?: ExecOptions): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = execCb(
        command,
        {
          cwd: opts?.cwd ?? this.defaultCwd,
          timeout: opts?.timeout ?? this.defaultTimeout,
          env: opts?.env
            ? { ...process.env, ...opts.env }
            : process.env,
          maxBuffer: 10 * 1024 * 1024,
          shell: "/bin/bash",
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode:
              error && "code" in error
                ? (error.code as number) ?? 1
                : child.exitCode ?? 0,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          });
        },
      );
    });
  }
}
