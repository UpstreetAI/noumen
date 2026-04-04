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
 * Sandboxed VirtualComputer that executes commands inside a remote
 * sprites.dev container. All shell execution is fully isolated — the agent
 * has no access to the host machine's processes, filesystem, or network.
 *
 * This is the recommended VirtualComputer for production deployments and
 * untrusted agents. See `LocalComputer` for an unsandboxed local alternative.
 *
 * Uses the non-interactive exec REST endpoint (POST command, receive
 * stdout/stderr/exit_code). The WebSocket exec endpoint can be used for
 * streaming/TTY use cases, but REST is sufficient for tool calls.
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
