import { LocalFs } from "./local-fs.js";
import { SandboxedLocalComputer, type SandboxConfig } from "./sandboxed-local-computer.js";
import type { Sandbox } from "./sandbox.js";

export type { SandboxConfig } from "./sandboxed-local-computer.js";

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
