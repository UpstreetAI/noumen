import type { VirtualFs } from "./fs.js";
import type { VirtualComputer } from "./computer.js";
import { LocalFs } from "./local-fs.js";
import { LocalComputer } from "./local-computer.js";
import { SpritesFs } from "./sprites-fs.js";
import { SpritesComputer } from "./sprites-computer.js";
import { DockerFs } from "./docker-fs.js";
import { DockerComputer, type DockerContainer } from "./docker-computer.js";
import { E2BFs } from "./e2b-fs.js";
import { E2BComputer, type E2BSandboxInstance } from "./e2b-computer.js";

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

export interface DockerSandboxOptions {
  /** A dockerode Container instance for the target container. */
  container: DockerContainer;
  /** Working directory inside the container. */
  cwd?: string;
  /** Default timeout (ms) for shell commands. */
  defaultTimeout?: number;
}

/**
 * Create a `Sandbox` backed by a Docker container.
 * Requires `dockerode` as an optional peer dependency.
 */
export function DockerSandbox(opts: DockerSandboxOptions): Sandbox {
  return {
    fs: new DockerFs({ container: opts.container, workingDir: opts.cwd }),
    computer: new DockerComputer({
      container: opts.container,
      defaultCwd: opts.cwd,
      defaultTimeout: opts.defaultTimeout,
    }),
  };
}

export interface E2BSandboxOptions {
  /** An E2B Sandbox instance created via `Sandbox.create()`. */
  sandbox: E2BSandboxInstance;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Default timeout (ms) for shell commands. */
  defaultTimeout?: number;
}

/**
 * Create a `Sandbox` backed by an E2B cloud sandbox.
 * Requires `e2b` as an optional peer dependency.
 */
export function E2BSandbox(opts: E2BSandboxOptions): Sandbox {
  return {
    fs: new E2BFs({ sandbox: opts.sandbox, workingDir: opts.cwd }),
    computer: new E2BComputer({
      sandbox: opts.sandbox,
      defaultCwd: opts.cwd,
      defaultTimeout: opts.defaultTimeout,
    }),
  };
}
