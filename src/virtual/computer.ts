export interface ExecOptions {
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VirtualComputer {
  executeCommand(
    command: string,
    opts?: ExecOptions,
  ): Promise<CommandResult>;
}
