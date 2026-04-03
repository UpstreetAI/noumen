import type {
  VirtualComputer,
  ExecOptions,
  CommandResult,
} from "./computer.js";

export interface SpritesComputerOptions {
  /** sprites.dev API token */
  token: string;
  /** Name of the sprite container */
  spriteName: string;
  /** Base URL for sprites API (default: https://api.sprites.dev) */
  baseURL?: string;
  /** Working directory inside the sprite (default: /home/sprite) */
  workingDir?: string;
}

/**
 * Executes commands inside a sprites.dev container via the exec REST endpoint.
 *
 * Uses the non-interactive exec mode: POST a command and get back
 * stdout/stderr/exit_code. For more complex use cases (streaming, TTY),
 * the WebSocket exec endpoint would be used, but for tool-call purposes
 * the REST endpoint is sufficient.
 */
export class SpritesComputer implements VirtualComputer {
  private token: string;
  private spriteName: string;
  private baseURL: string;
  private workingDir: string;

  constructor(opts: SpritesComputerOptions) {
    this.token = opts.token;
    this.spriteName = opts.spriteName;
    this.baseURL = (opts.baseURL ?? "https://api.sprites.dev").replace(
      /\/$/,
      "",
    );
    this.workingDir = opts.workingDir ?? "/home/sprite";
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  async executeCommand(
    command: string,
    opts?: ExecOptions,
  ): Promise<CommandResult> {
    const cwd = opts?.cwd ?? this.workingDir;
    const wrappedCommand = `cd ${this.shellEscape(cwd)} && ${command}`;

    const url = `${this.baseURL}/v1/sprites/${this.spriteName}/exec`;

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        command: ["bash", "-c", wrappedCommand],
        timeout: opts?.timeout ?? 30_000,
        env: opts?.env,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Sprites exec failed (${res.status}): ${text}`,
      };
    }

    const data = (await res.json()) as {
      exit_code: number;
      stdout: string;
      stderr: string;
    };

    return {
      exitCode: data.exit_code,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
    };
  }

  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
}
