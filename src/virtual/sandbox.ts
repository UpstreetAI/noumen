import type { VirtualFs } from "./fs.js";
import type { VirtualComputer } from "./computer.js";
import { LocalFs } from "./local-fs.js";
import { LocalComputer } from "./local-computer.js";
import { SandboxedLocalComputer, type SandboxConfig } from "./sandboxed-local-computer.js";

export type { SandboxConfig } from "./sandboxed-local-computer.js";

/**
 * Bundled sandbox: a `VirtualFs` and `VirtualComputer` paired together.
 *
 * Use one of the built-in factories (`LocalSandbox`, `UnsandboxedLocal`)
 * or import a remote backend from its subpath
 * (`noumen/docker`, `noumen/e2b`, `noumen/freestyle`, `noumen/ssh`,
 * `noumen/sprites`). You can also supply any object that satisfies this
 * shape for custom sandboxes (in-memory, custom cloud backends, etc.).
 */
export interface Sandbox {
  fs: VirtualFs;
  computer: VirtualComputer;
  /** Optional cleanup — called by Agent.close() to tear down OS-level sandbox state. */
  dispose?(): Promise<void>;
  /**
   * Lazily provision the underlying sandbox resource. Idempotent — repeated
   * calls return the same single-flight promise.
   *
   * When `sandboxId` is provided the sandbox reconnects to an existing
   * resource instead of creating a new one. This is used during session
   * resume: the stored sandbox identifier is read from session metadata
   * and passed here so the agent reattaches to its previous container.
   *
   * When omitted a fresh resource is provisioned (for factories that
   * support auto-creation) or the call is a no-op (for factories that
   * were given a pre-created resource up front).
   */
  init?(sandboxId?: string): Promise<void>;
  /**
   * Return the opaque identifier for this sandbox instance so it can be
   * persisted in session metadata and used to reconnect later via `init()`.
   * Returns `undefined` before `init()` has resolved or for sandboxes
   * that don't support reconnection.
   */
  sandboxId?(): string | undefined;
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
