import type { Sandbox } from "./sandbox.js";
import { FreestyleFs } from "./freestyle-fs.js";
import { FreestyleComputer, type FreestyleVmInstance } from "./freestyle-computer.js";
import { createFsProxy, createComputerProxy } from "./proxy.js";

export interface FreestyleSandboxOptions {
  /**
   * A pre-existing Freestyle VM instance. When provided the sandbox
   * attaches to this VM directly — no auto-creation occurs and
   * `dispose()` will **not** suspend or delete it.
   *
   * When omitted, a new VM is created on the first `init()` call via
   * a dynamic import of the `freestyle-sandboxes` package.
   */
  vm?: FreestyleVmInstance;
  /**
   * Freestyle API key. Falls back to the `FREESTYLE_API_KEY` environment
   * variable when omitted. Only used during auto-creation.
   */
  apiKey?: string;
  /** Snapshot ID to create the VM from. Only used during auto-creation. */
  snapshotId?: string;
  /**
   * A `VmSpec` instance or configuration object passed through to
   * `freestyle.vms.create()`. Only used during auto-creation.
   */
  spec?: unknown;
  /**
   * Idle timeout in seconds for the auto-created VM (default: 600).
   * The VM auto-suspends after this many seconds of network inactivity.
   */
  idleTimeoutSeconds?: number;
  /** Working directory inside the VM. */
  cwd?: string;
  /** Default timeout (ms) for shell commands. */
  defaultTimeout?: number;
  /** Files to provision at creation time. */
  additionalFiles?: Record<string, { content: string; encoding?: string }>;
  /** Git repos to clone at creation time. */
  gitRepos?: Array<{ repo: string; path: string; rev?: string }>;
  /**
   * What to do with auto-created VMs on `dispose()`:
   * - `"suspend"` (default) — suspends the VM, preserving full memory
   *   state for near-instant resume on reconnect.
   * - `"delete"` — permanently deletes the VM and frees all resources.
   */
  disposeStrategy?: "suspend" | "delete";
}

/**
 * Create a `Sandbox` backed by a Freestyle VM.
 * Requires `freestyle-sandboxes` as an optional peer dependency.
 *
 * **Auto-creation:** When `vm` is omitted a new Freestyle VM is
 * provisioned lazily on the first `init()` call. The VM ID is available
 * through `sandboxId()` for session persistence. Pass the stored ID back
 * through `init(storedId)` to reconnect (this also wakes suspended VMs).
 *
 * By default, auto-created VMs are **suspended** on `dispose()` rather
 * than deleted. This preserves full memory state and allows near-instant
 * resume. Set `disposeStrategy: "delete"` for full cleanup.
 *
 * **Explicit instance:** When `vm` is provided, `init()` binds it
 * immediately. `dispose()` is a no-op — the caller owns the VM's
 * lifecycle.
 *
 * @example
 * ```ts
 * // Auto-create — VM provisioned on first init()
 * const sandbox = FreestyleSandbox({ cwd: "/workspace" });
 *
 * // Auto-create from a snapshot
 * const sandbox = FreestyleSandbox({
 *   snapshotId: "abc123",
 *   cwd: "/workspace",
 * });
 *
 * // Explicit — attach to pre-existing VM
 * const sandbox = FreestyleSandbox({ vm: existingVm });
 * ```
 */
export function FreestyleSandbox(opts: FreestyleSandboxOptions): Sandbox {
  if (opts.vm) {
    const v = opts.vm;
    return {
      fs: new FreestyleFs({ vm: v, workingDir: opts.cwd }),
      computer: new FreestyleComputer({
        vm: v,
        defaultCwd: opts.cwd,
        defaultTimeout: opts.defaultTimeout,
      }),
      sandboxId: () => (v as any).vmId as string | undefined,
    };
  }

  const fsProxy = createFsProxy();
  const computerProxy = createComputerProxy();
  let resolvedId: string | undefined;
  let vmRef: FreestyleVmInstance | null = null;
  let autoCreated = false;
  let initPromise: Promise<void> | null = null;

  async function doInit(reconnectId?: string): Promise<void> {
    const mod = await import("freestyle-sandboxes");
    const freestyle = (mod as any).freestyle ?? (mod as any).default?.freestyle;
    if (!freestyle?.vms) {
      throw new Error("Could not resolve freestyle client from 'freestyle-sandboxes' package");
    }

    let vm: FreestyleVmInstance;
    if (reconnectId) {
      try {
        const result = await freestyle.vms.get({ vmId: reconnectId });
        vm = result.vm;
        resolvedId = reconnectId;
      } catch {
        const result = await freestyle.vms.create({
          ...(opts.spec ? { spec: opts.spec } : {}),
          snapshotId: opts.snapshotId,
          workdir: opts.cwd,
          idleTimeoutSeconds: opts.idleTimeoutSeconds ?? 600,
          additionalFiles: opts.additionalFiles,
          gitRepos: opts.gitRepos,
        });
        vm = result.vm;
        resolvedId = result.vmId ?? result.id;
        autoCreated = true;
      }
    } else {
      const result = await freestyle.vms.create({
        ...(opts.spec ? { spec: opts.spec } : {}),
        snapshotId: opts.snapshotId,
        workdir: opts.cwd,
        idleTimeoutSeconds: opts.idleTimeoutSeconds ?? 600,
        additionalFiles: opts.additionalFiles,
        gitRepos: opts.gitRepos,
      });
      vm = result.vm;
      resolvedId = result.vmId ?? result.id;
      autoCreated = true;
    }

    vmRef = vm;
    fsProxy.setTarget(new FreestyleFs({ vm, workingDir: opts.cwd }));
    computerProxy.setTarget(new FreestyleComputer({
      vm,
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
      if (!autoCreated || !vmRef || !resolvedId) return;
      try {
        const strategy = opts.disposeStrategy ?? "suspend";
        if (strategy === "suspend") {
          await vmRef.suspend();
        } else {
          const mod = await import("freestyle-sandboxes");
          const freestyle = (mod as any).freestyle ?? (mod as any).default?.freestyle;
          if (freestyle?.vms) {
            await freestyle.vms.delete({ vmId: resolvedId });
          }
        }
      } catch {
        // Best-effort cleanup — network errors during dispose are non-fatal
      }
    },
  };
}
