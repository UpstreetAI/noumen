// Unsandboxed local binding — raw host access, no isolation.
//
// Importing this subpath is the explicit opt-in to a sandbox that gives the
// agent everything the host process has. The root barrel (`noumen`) does not
// re-export this module, so reaching for unsandboxed execution always shows
// up as a dedicated import line.
//
//   import { UnsandboxedLocal } from "noumen/unsandboxed";

import { Agent, type AgentOptions } from "./agent.js";
import { UnsandboxedLocal, type UnsandboxedLocalOptions } from "./virtual/unsandboxed.js";

export {
  UnsandboxedLocal,
  type UnsandboxedLocalOptions,
} from "./virtual/unsandboxed.js";

/**
 * Options for {@link UnsandboxedAgent} — the full `AgentOptions` surface
 * minus `sandbox`, plus an optional `unsandboxed` block for tuning the
 * default-created {@link UnsandboxedLocal} (timeouts, etc.).
 */
export interface UnsandboxedAgentOptions extends Omit<AgentOptions, "sandbox"> {
  /**
   * Forwarded to {@link UnsandboxedLocal}. If `cwd` is omitted here it
   * defaults to `opts.cwd` / `opts.options.cwd` / `process.cwd()`.
   */
  unsandboxed?: Omit<UnsandboxedLocalOptions, "cwd"> & { cwd?: string };
}

/**
 * Convenience factory that constructs an {@link Agent} backed by an
 * {@link UnsandboxedLocal} sandbox. Equivalent to:
 *
 * ```ts
 * new Agent({ ...opts, sandbox: UnsandboxedLocal({ cwd }) })
 * ```
 *
 * Lives on the `noumen/unsandboxed` subpath rather than the root barrel
 * so that `import { Agent } from "noumen"` never transitively pulls
 * `node:child_process` into the module graph. Callers who want raw host
 * access opt into that cost at the import line.
 *
 * For production, prefer {@link "./local".LocalAgent} (OS-level sandboxing)
 * or a remote sandbox subpath.
 */
export function UnsandboxedAgent(opts: UnsandboxedAgentOptions): Agent {
  const cwd = opts.unsandboxed?.cwd ?? opts.cwd ?? opts.options?.cwd ?? process.cwd();
  const { unsandboxed, ...rest } = opts;
  return new Agent({
    ...rest,
    sandbox: UnsandboxedLocal({
      cwd,
      defaultTimeout: unsandboxed?.defaultTimeout,
    }),
  });
}
