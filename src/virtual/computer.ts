export interface ExecOptions {
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Sandboxed shell execution interface.
 *
 * `VirtualComputer` is noumen's primary isolation boundary for command
 * execution. Every built-in tool that runs shell commands (Bash, Glob, Grep)
 * delegates to this interface — the agent never spawns processes directly.
 *
 * Swap implementations to control where and how commands run:
 * - `LocalComputer`   — runs on the host machine (no isolation, for local dev)
 * - `SpritesComputer`  — runs in a remote sprites.dev container (full sandbox)
 * - Custom             — implement this interface for Docker, E2B, Daytona, etc.
 */
export interface VirtualComputer {
  executeCommand(
    command: string,
    opts?: ExecOptions,
  ): Promise<CommandResult>;
}
