// Local sandbox binding (OS-level isolation via @anthropic-ai/sandbox-runtime).
//
// Importing this subpath pulls in the local sandbox factory and its adapter
// primitives. The root barrel (`noumen`) intentionally does not re-export
// this module so that `import { Agent } from "noumen"` stays structurally
// lightweight and every sandbox is opted into by import.
//
//   import { LocalSandbox } from "noumen/local";

import { Agent, type AgentOptions } from "./agent.js";
import { LocalSandbox, type LocalSandboxOptions } from "./virtual/local-sandbox.js";

export {
  LocalSandbox,
  type LocalSandboxOptions,
  type SandboxConfig,
} from "./virtual/local-sandbox.js";
export { LocalFs, type LocalFsOptions } from "./virtual/local-fs.js";
export {
  LocalComputer,
  type LocalComputerOptions,
} from "./virtual/local-computer.js";
export {
  SandboxedLocalComputer,
  type SandboxedLocalComputerOptions,
} from "./virtual/sandboxed-local-computer.js";

/**
 * Options for {@link LocalAgent} — the full `AgentOptions` surface minus
 * `sandbox`, plus an optional `localSandbox` block for tuning the
 * default-created {@link LocalSandbox} (filesystem / network restrictions,
 * command timeouts).
 */
export interface LocalAgentOptions extends Omit<AgentOptions, "sandbox"> {
  /**
   * Forwarded to {@link LocalSandbox}. If `cwd` is omitted here it
   * defaults to `opts.cwd` / `opts.options.cwd` / `process.cwd()`.
   */
  localSandbox?: Omit<LocalSandboxOptions, "cwd"> & { cwd?: string };
}

/**
 * Convenience factory that constructs an {@link Agent} backed by a
 * {@link LocalSandbox} (OS-level sandboxing via
 * `@anthropic-ai/sandbox-runtime`). Equivalent to:
 *
 * ```ts
 * new Agent({ ...opts, sandbox: LocalSandbox({ cwd }) })
 * ```
 *
 * Lives on the `noumen/local` subpath rather than the root barrel so that
 * `import { Agent } from "noumen"` never transitively pulls the local
 * computer adapter (and `node:child_process`) into the module graph.
 *
 * Defaults: writes allowed only in `cwd`, reads allowed everywhere,
 * network unrestricted. Pass `localSandbox.sandbox` to tighten.
 */
export function LocalAgent(opts: LocalAgentOptions): Agent {
  const cwd = opts.localSandbox?.cwd ?? opts.cwd ?? opts.options?.cwd ?? process.cwd();
  const { localSandbox, ...rest } = opts;
  return new Agent({
    ...rest,
    sandbox: LocalSandbox({
      cwd,
      defaultTimeout: localSandbox?.defaultTimeout,
      sandbox: localSandbox?.sandbox,
    }),
  });
}
