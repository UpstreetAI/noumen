import type { VirtualFs } from "./fs.js";
import type { VirtualComputer } from "./computer.js";
import { LocalFs } from "./local-fs.js";
import { LocalComputer } from "./local-computer.js";
import { SandboxedLocalComputer, type SandboxConfig } from "./sandboxed-local-computer.js";
import { SpritesFs } from "./sprites-fs.js";
import { SpritesComputer } from "./sprites-computer.js";
import { DockerFs } from "./docker-fs.js";
import { DockerComputer, type DockerContainer } from "./docker-computer.js";
import { E2BFs } from "./e2b-fs.js";
import { E2BComputer, type E2BSandboxInstance } from "./e2b-computer.js";

export type { SandboxConfig } from "./sandboxed-local-computer.js";

/**
 * Bundled sandbox: a `VirtualFs` and `VirtualComputer` paired together.
 *
 * Use one of the built-in factories (`LocalSandbox`, `UnsandboxedLocal`,
 * `SpritesSandbox`) or supply any object that satisfies this shape for
 * custom sandboxes (Docker, E2B, Daytona, in-memory, etc.).
 */
export interface Sandbox {
  fs: VirtualFs;
  computer: VirtualComputer;
  /** Optional cleanup — called by Agent.close() to tear down OS-level sandbox state. */
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// UnsandboxedLocal — raw host access, no isolation
// ---------------------------------------------------------------------------

export interface UnsandboxedLocalOptions {
  /** Working directory for both file resolution and command execution. */
  cwd?: string;
  /** Default timeout (ms) for shell commands. */
  defaultTimeout?: number;
}

/**
 * Create a `Sandbox` backed by the host filesystem and shell with **no
 * OS-level isolation**. The agent can access anything the host process can.
 *
 * Use this for development or fully-trusted environments where sandboxing
 * overhead is unwanted. For production use, prefer `LocalSandbox()` (which
 * wraps commands with `@anthropic-ai/sandbox-runtime`).
 */
export function UnsandboxedLocal(opts?: UnsandboxedLocalOptions): Sandbox {
  const cwd = opts?.cwd;
  return {
    fs: new LocalFs({ basePath: cwd }),
    computer: new LocalComputer({
      defaultCwd: cwd,
      defaultTimeout: opts?.defaultTimeout,
    }),
  };
}

// ---------------------------------------------------------------------------
// LocalSandbox — OS-level sandboxing via @anthropic-ai/sandbox-runtime
// ---------------------------------------------------------------------------

export interface LocalSandboxOptions {
  /** Working directory for both file resolution and command execution. */
  cwd?: string;
  /** Default timeout (ms) for shell commands. */
  defaultTimeout?: number;
  /**
   * Sandbox restrictions. Defaults: writes allowed only in `cwd`,
   * reads allowed everywhere, network unrestricted.
   */
  sandbox?: SandboxConfig;
}

/**
 * Create a `Sandbox` with OS-level isolation via `@anthropic-ai/sandbox-runtime`.
 *
 * - **macOS**: Seatbelt (`sandbox-exec`) profiles restrict filesystem and network.
 * - **Linux**: bubblewrap (`bwrap`) + socat for namespace-based isolation.
 *
 * Filesystem operations (`VirtualFs`) use the host `node:fs` — the sandbox
 * boundary is enforced on shell commands (`VirtualComputer`), which is where
 * the agent executes arbitrary code.
 *
 * Requires `@anthropic-ai/sandbox-runtime` as a peer dependency.
 */
export function LocalSandbox(opts?: LocalSandboxOptions): Sandbox {
  const cwd = opts?.cwd ?? process.cwd();
  const computer = new SandboxedLocalComputer({
    defaultCwd: cwd,
    defaultTimeout: opts?.defaultTimeout,
    sandbox: {
      filesystem: {
        allowWrite: [cwd, ...(opts?.sandbox?.filesystem?.allowWrite ?? [])],
        denyWrite: opts?.sandbox?.filesystem?.denyWrite,
        denyRead: opts?.sandbox?.filesystem?.denyRead,
        allowRead: opts?.sandbox?.filesystem?.allowRead,
      },
      network: opts?.sandbox?.network,
    },
  });
  return {
    fs: new LocalFs({ basePath: cwd }),
    computer,
    dispose: () => computer.dispose(),
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
