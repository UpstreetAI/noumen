import type { Sandbox } from "./sandbox.js";
import { E2BFs } from "./e2b-fs.js";
import { E2BComputer, type E2BSandboxInstance } from "./e2b-computer.js";
import { createFsProxy, createComputerProxy } from "./proxy.js";

export interface E2BSandboxOptions {
  /**
   * A pre-existing E2B Sandbox instance (e.g. from `Sandbox.create()`).
   * When provided the sandbox attaches to this instance — no auto-creation
   * occurs and `dispose()` will **not** kill it.
   *
   * When omitted, a new E2B sandbox is created on the first `init()` call
   * via a dynamic import of the `e2b` package. The auto-created sandbox
   * is killed when `dispose()` is called.
   */
  sandbox?: E2BSandboxInstance;
  /**
   * E2B template to use for auto-creation (default: `"base"`).
   * Only used when `sandbox` is omitted.
   */
  template?: string;
  /**
   * E2B API key. Falls back to the `E2B_API_KEY` environment variable
   * when omitted. Only used during auto-creation.
   */
  apiKey?: string;
  /** Timeout (ms) for the auto-created E2B sandbox (default: E2B SDK default). */
  timeoutMs?: number;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Default timeout (ms) for shell commands. */
  defaultTimeout?: number;
}

/**
 * Create a `Sandbox` backed by an E2B cloud sandbox.
 * Requires `e2b` as an optional peer dependency.
 *
 * **Auto-creation:** When `sandbox` is omitted the E2B sandbox is
 * provisioned lazily on the first `init()` call via the E2B SDK.
 * The sandbox ID is available through `sandboxId()` for session
 * persistence. Pass the stored ID back through `init(storedId)` to
 * reconnect to the same sandbox on resume (via `Sandbox.connect()`).
 *
 * **Explicit instance:** When `sandbox` is provided, `init()` binds
 * it immediately. `dispose()` is a no-op — the caller owns the
 * sandbox's lifecycle.
 *
 * @example
 * ```ts
 * // Auto-create — sandbox provisioned on first init()
 * const sandbox = E2BSandbox({ template: "base" });
 *
 * // Explicit — attach to pre-existing instance
 * const sandbox = E2BSandbox({ sandbox: await E2BSdk.Sandbox.create() });
 * ```
 */
export function E2BSandbox(opts: E2BSandboxOptions): Sandbox {
  if (opts.sandbox) {
    const s = opts.sandbox;
    return {
      fs: new E2BFs({ sandbox: s, workingDir: opts.cwd }),
      computer: new E2BComputer({
        sandbox: s,
        defaultCwd: opts.cwd,
        defaultTimeout: opts.defaultTimeout,
      }),
      sandboxId: () => (s as any).sandboxId as string | undefined,
    };
  }

  const fsProxy = createFsProxy();
  const computerProxy = createComputerProxy();
  let resolvedId: string | undefined;
  let sandboxRef: any;
  let autoCreated = false;
  let initPromise: Promise<void> | null = null;

  async function doInit(reconnectId?: string): Promise<void> {
    const e2b = await import("e2b");
    const SandboxClass = (e2b as any).Sandbox ?? (e2b as any).default?.Sandbox;
    if (!SandboxClass) {
      throw new Error("Could not resolve Sandbox class from 'e2b' package");
    }

    let sandbox: E2BSandboxInstance;
    if (reconnectId) {
      try {
        sandbox = await SandboxClass.connect(reconnectId, {
          apiKey: opts.apiKey,
        });
      } catch {
        sandbox = await SandboxClass.create({
          template: opts.template ?? "base",
          apiKey: opts.apiKey,
          timeoutMs: opts.timeoutMs,
        });
        autoCreated = true;
      }
    } else {
      sandbox = await SandboxClass.create({
        template: opts.template ?? "base",
        apiKey: opts.apiKey,
        timeoutMs: opts.timeoutMs,
      });
      autoCreated = true;
    }

    sandboxRef = sandbox;
    resolvedId = (sandbox as any).sandboxId ?? reconnectId;
    fsProxy.setTarget(new E2BFs({ sandbox, workingDir: opts.cwd }));
    computerProxy.setTarget(new E2BComputer({
      sandbox,
      defaultCwd: opts.cwd,
      defaultTimeout: opts.defaultTimeout,
    }));
  }

  return {
    fs: fsProxy,
    computer: computerProxy,
    sandboxId: () => resolvedId,

    init(sandboxId?: string): Promise<void> {
      if (!initPromise) {
        initPromise = doInit(sandboxId).catch((err) => {
          initPromise = null;
          throw err;
        });
      }
      return initPromise;
    },

    async dispose(): Promise<void> {
      if (initPromise) {
        await initPromise.catch(() => {});
      }
      if (!autoCreated || !sandboxRef) return;
      if (typeof sandboxRef.kill === "function") {
        await sandboxRef.kill();
      }
    },
  };
}
