import type { VirtualComputer, ExecOptions, CommandResult } from "./computer.js";

/**
 * Minimal subset of the E2B Sandbox interface used by E2BComputer and E2BFs.
 * Avoids a hard import of `e2b` at the module level.
 */
export interface E2BSandboxInstance {
  commands: {
    run(
      cmd: string,
      opts?: {
        cwd?: string;
        timeout?: number;
        envs?: Record<string, string>;
      },
    ): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  };
  files: {
    read(path: string, opts?: { format?: string }): Promise<string>;
    write(path: string, data: string): Promise<unknown>;
    remove(path: string): Promise<void>;
    makeDir(path: string): Promise<unknown>;
    list(path: string): Promise<
      Array<{
        name: string;
        path: string;
        type?: string;
        size?: number;
        modifiedTime?: Date;
      }>
    >;
    exists(path: string): Promise<boolean>;
    getInfo(path: string): Promise<{
      name: string;
      path: string;
      type?: string;
      size?: number;
      modifiedTime?: Date;
    }>;
  };
}

export interface E2BComputerOptions {
  /** An E2B Sandbox instance created via `Sandbox.create()`. */
  sandbox: E2BSandboxInstance;
  /** Default working directory for commands. */
  defaultCwd?: string;
  /** Default timeout in ms for commands (default: 30000). */
  defaultTimeout?: number;
}

/**
 * VirtualComputer backed by command execution in an E2B cloud sandbox.
 *
 * Requires `e2b` as an optional peer dependency.
 * The user is responsible for sandbox lifecycle (create, close).
 */
export class E2BComputer implements VirtualComputer {
  private sandbox: E2BSandboxInstance;
  private defaultCwd: string | undefined;
  private defaultTimeout: number;

  constructor(opts: E2BComputerOptions) {
    this.sandbox = opts.sandbox;
    this.defaultCwd = opts.defaultCwd;
    this.defaultTimeout = opts.defaultTimeout ?? 30_000;
  }

  async executeCommand(
    command: string,
    opts?: ExecOptions,
  ): Promise<CommandResult> {
    const result = await this.sandbox.commands.run(command, {
      cwd: opts?.cwd ?? this.defaultCwd,
      timeout: opts?.timeout ?? this.defaultTimeout,
      envs: opts?.env,
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}
