import { LocalFs } from "./local-fs.js";
import { LocalComputer } from "./local-computer.js";
import type { Sandbox } from "./sandbox.js";

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
