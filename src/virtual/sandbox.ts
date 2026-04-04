import type { VirtualFs } from "./fs.js";
import type { VirtualComputer } from "./computer.js";
import { LocalFs } from "./local-fs.js";
import { LocalComputer } from "./local-computer.js";
import { SpritesFs } from "./sprites-fs.js";
import { SpritesComputer } from "./sprites-computer.js";

/**
 * Bundled sandbox: a `VirtualFs` and `VirtualComputer` paired together.
 *
 * Use one of the built-in factories (`LocalSandbox`, `SpritesSandbox`) or
 * supply any object that satisfies this shape for custom sandboxes
 * (Docker, E2B, Daytona, in-memory, etc.).
 */
export interface Sandbox {
  fs: VirtualFs;
  computer: VirtualComputer;
}

export interface LocalSandboxOptions {
  /** Working directory for both file resolution and command execution. */
  cwd?: string;
  /** Default timeout (ms) for shell commands. */
  defaultTimeout?: number;
}

/**
 * Create a `Sandbox` backed by the host filesystem and shell.
 * No isolation — suitable for local development and trusted environments.
 */
export function LocalSandbox(opts?: LocalSandboxOptions): Sandbox {
  const cwd = opts?.cwd;
  return {
    fs: new LocalFs({ basePath: cwd }),
    computer: new LocalComputer({
      defaultCwd: cwd,
      defaultTimeout: opts?.defaultTimeout,
    }),
  };
}

export interface SpritesSandboxOptions {
  /** sprites.dev API token. */
  token: string;
  /** Name of the sprite container. */
  spriteName: string;
  /** Base URL for sprites API (default: https://api.sprites.dev). */
  baseURL?: string;
  /** Working directory inside the sprite (default: /home/sprite). */
  workingDir?: string;
}

/**
 * Create a `Sandbox` backed by a remote sprites.dev container.
 * Full isolation — the agent has no access to the host machine.
 */
export function SpritesSandbox(opts: SpritesSandboxOptions): Sandbox {
  return {
    fs: new SpritesFs(opts),
    computer: new SpritesComputer(opts),
  };
}
