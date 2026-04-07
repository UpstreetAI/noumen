import type { VirtualComputer, ExecOptions, CommandResult } from "./computer.js";

/**
 * Minimal subset of the Freestyle VM interface used by FreestyleComputer and
 * FreestyleFs. Avoids a hard import of `freestyle-sandboxes` at the module
 * level — the real SDK is only loaded dynamically during `FreestyleSandbox`
 * auto-creation.
 */
export interface FreestyleVmInstance {
  exec(
    command: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<{
    stdout: string | null;
    stderr: string | null;
    statusCode: number | null;
  }>;
  fs: {
    readTextFile(path: string): Promise<string>;
    writeTextFile(path: string, content: string): Promise<void>;
    readDir(path: string): Promise<Array<{ name: string; kind: string }>>;
  };
  suspend(): Promise<unknown>;
  start(): Promise<unknown>;
}

export interface FreestyleComputerOptions {
  /** A Freestyle VM instance. */
  vm: FreestyleVmInstance;
  /** Default working directory for commands. */
  defaultCwd?: string;
  /** Default timeout in ms for commands (default: 30000). */
  defaultTimeout?: number;
}

/**
 * VirtualComputer backed by command execution in a Freestyle VM.
 *
 * Requires `freestyle-sandboxes` as an optional peer dependency.
 * The user is responsible for VM lifecycle when using explicit mode.
 */
export class FreestyleComputer implements VirtualComputer {
  private vm: FreestyleVmInstance;
  private defaultCwd: string | undefined;
  private defaultTimeout: number;

  constructor(opts: FreestyleComputerOptions) {
    this.vm = opts.vm;
    this.defaultCwd = opts.defaultCwd;
    this.defaultTimeout = opts.defaultTimeout ?? 30_000;
  }

  async executeCommand(
    command: string,
    opts?: ExecOptions,
  ): Promise<CommandResult> {
    const result = await this.vm.exec(command, {
      cwd: opts?.cwd ?? this.defaultCwd,
      timeout: opts?.timeout ?? this.defaultTimeout,
    });

    return {
      exitCode: result.statusCode ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}
