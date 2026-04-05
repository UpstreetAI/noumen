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
// Proxy helpers — thin forwarding wrappers whose inner target is set by
// the sandbox factory's init(). Methods throw until the target is bound.
// ---------------------------------------------------------------------------

type FsProxySetter = { setTarget(target: VirtualFs): void };
type ComputerProxySetter = { setTarget(target: VirtualComputer): void };

function uninitError(): never {
  throw new Error(
    "Sandbox not initialized — call init() or pass a pre-created resource",
  );
}

function createFsProxy(): VirtualFs & FsProxySetter {
  let inner: VirtualFs | null = null;
  const get = (): VirtualFs => inner ?? uninitError();
  return {
    setTarget(target: VirtualFs) { inner = target; },
    readFile: (...args) => get().readFile(...args),
    readFileBytes: (...args) => get().readFileBytes?.(...args) as any,
    writeFile: (...args) => get().writeFile(...args),
    appendFile: (...args) => get().appendFile(...args),
    deleteFile: (...args) => get().deleteFile(...args),
    mkdir: (...args) => get().mkdir(...args),
    readdir: (...args) => get().readdir(...args),
    exists: (...args) => get().exists(...args),
    stat: (...args) => get().stat(...args),
  };
}

function createComputerProxy(): VirtualComputer & ComputerProxySetter {
  let inner: VirtualComputer | null = null;
  const get = (): VirtualComputer => inner ?? uninitError();
  return {
    setTarget(target: VirtualComputer) { inner = target; },
    executeCommand: (...args) => get().executeCommand(...args),
  };
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
  /**
   * Name of an existing sprite container. When provided the sandbox
   * attaches to this sprite directly — no auto-creation occurs and
   * `dispose()` will **not** delete it (lifecycle is yours to manage).
   *
   * When omitted a new sprite is provisioned on the first `init()` call
   * (via `POST /v1/sprites`). The auto-created sprite is deleted when
   * `dispose()` is called, and its name is available via `sandboxId()`
   * for session persistence.
   */
  spriteName?: string;
  /** Base URL for sprites API (default: https://api.sprites.dev). */
  baseURL?: string;
  /** Working directory inside the sprite (default: /home/sprite). */
  workingDir?: string;
  /**
   * Optional prefix for auto-generated sprite names (default: "noumen-").
   * Only used when `spriteName` is omitted.
   */
  namePrefix?: string;
}

/**
 * Create a `Sandbox` backed by a remote sprites.dev container.
 * Full isolation — the agent has no access to the host machine.
 *
 * **Auto-creation:** When `spriteName` is omitted the sandbox is created
 * lazily on the first `init()` call via the Sprites REST API. The sprite
 * name is available through `sandboxId()` so callers can persist it in
 * session metadata for reconnection on resume. Pass the stored name back
 * through `init(storedId)` to reattach instead of creating a new sprite.
 *
 * **Explicit ID:** When `spriteName` is provided the sandbox attaches to
 * that sprite immediately on `init()`. `dispose()` is a no-op in this
 * case — the caller owns the sprite's lifecycle.
 *
 * @example
 * ```ts
 * // Auto-create — sprite provisioned on first init()
 * const sandbox = SpritesSandbox({ token: process.env.SPRITES_TOKEN! });
 *
 * // Explicit — attach to pre-existing sprite, no auto-lifecycle
 * const sandbox = SpritesSandbox({
 *   token: process.env.SPRITES_TOKEN!,
 *   spriteName: "my-sprite",
 * });
 * ```
 */
export function SpritesSandbox(opts: SpritesSandboxOptions): Sandbox {
  const baseURL = (opts.baseURL ?? "https://api.sprites.dev").replace(/\/$/, "");
  const userProvidedName = opts.spriteName;

  if (userProvidedName) {
    const fsOpts = { ...opts, spriteName: userProvidedName };
    return {
      fs: new SpritesFs(fsOpts),
      computer: new SpritesComputer(fsOpts),
      sandboxId: () => userProvidedName,
    };
  }

  const fsProxy = createFsProxy();
  const computerProxy = createComputerProxy();
  let resolvedName: string | undefined;
  let autoCreated = false;
  let initPromise: Promise<void> | null = null;

  async function doInit(reconnectId?: string): Promise<void> {
    const name = reconnectId ?? `${opts.namePrefix ?? "noumen-"}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (!reconnectId) {
      const res = await fetch(`${baseURL}/v1/sprites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        throw new Error(`Sprites auto-create failed (${res.status}): ${await res.text()}`);
      }
      autoCreated = true;
    }

    resolvedName = name;
    const childOpts = { ...opts, spriteName: name };
    fsProxy.setTarget(new SpritesFs(childOpts));
    computerProxy.setTarget(new SpritesComputer(childOpts));
  }

  return {
    fs: fsProxy,
    computer: computerProxy,
    sandboxId: () => resolvedName,

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
      if (!autoCreated || !resolvedName) return;
      try {
        const res = await fetch(`${baseURL}/v1/sprites/${resolvedName}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${opts.token}` },
        });
        if (!res.ok && res.status !== 404) {
          throw new Error(`Sprites dispose failed (${res.status}): ${await res.text()}`);
        }
      } catch {
        // Best-effort cleanup — network errors during dispose are non-fatal
      }
    },
  };
}

export interface DockerSandboxOptions {
  /**
   * A pre-existing dockerode Container instance. When provided the sandbox
   * attaches to this container directly — no auto-creation occurs and
   * `dispose()` will **not** stop or remove it.
   *
   * When omitted, a new container is created from `image` on the first
   * `init()` call via a dynamic import of `dockerode`. The auto-created
   * container is stopped and removed when `dispose()` is called.
   */
  container?: DockerContainer;
  /**
   * Docker image to use for auto-creation (e.g. `"ubuntu:22.04"`).
   * Required when `container` is omitted; ignored when `container` is provided.
   */
  image?: string;
  /** Command to run in the auto-created container (default: `["sleep", "infinity"]`). */
  cmd?: string[];
  /** Environment variables for the auto-created container. */
  env?: string[];
  /** Extra options passed to dockerode `createContainer`. */
  dockerOptions?: Record<string, unknown>;
  /** Working directory inside the container. */
  cwd?: string;
  /** Default timeout (ms) for shell commands. */
  defaultTimeout?: number;
}

/**
 * Create a `Sandbox` backed by a Docker container.
 * Requires `dockerode` as an optional peer dependency.
 *
 * **Auto-creation:** When `container` is omitted and `image` is provided,
 * the container is created and started lazily on the first `init()` call.
 * The container ID is available through `sandboxId()` for session
 * persistence. Pass the stored ID back through `init(storedId)` to
 * reattach to an existing container on resume.
 *
 * **Explicit container:** When `container` is provided, `init()` binds
 * it immediately. `dispose()` is a no-op — the caller owns the
 * container's lifecycle.
 *
 * @example
 * ```ts
 * // Auto-create from image
 * const sandbox = DockerSandbox({ image: "ubuntu:22.04", cwd: "/workspace" });
 *
 * // Explicit container (lifecycle managed externally)
 * const sandbox = DockerSandbox({ container: myDockerodeContainer });
 * ```
 */
export function DockerSandbox(opts: DockerSandboxOptions): Sandbox {
  if (opts.container) {
    const c = opts.container;
    return {
      fs: new DockerFs({ container: c, workingDir: opts.cwd }),
      computer: new DockerComputer({
        container: c,
        defaultCwd: opts.cwd,
        defaultTimeout: opts.defaultTimeout,
      }),
      sandboxId: () => (c as any).id as string | undefined,
    };
  }

  if (!opts.image) {
    throw new Error("DockerSandbox requires either `container` or `image`");
  }

  const fsProxy = createFsProxy();
  const computerProxy = createComputerProxy();
  let containerId: string | undefined;
  let containerRef: any;
  let autoCreated = false;
  let initPromise: Promise<void> | null = null;

  async function doInit(reconnectId?: string): Promise<void> {
    const Docker = (await import("dockerode")).default;
    const docker = new Docker();

    let container: any;
    if (reconnectId) {
      container = docker.getContainer(reconnectId);
    } else {
      container = await docker.createContainer({
        Image: opts.image!,
        Cmd: opts.cmd ?? ["sleep", "infinity"],
        Env: opts.env,
        Tty: false,
        ...opts.dockerOptions,
      });
      await container.start();
      autoCreated = true;
    }

    containerRef = container;
    containerId = container.id;
    fsProxy.setTarget(new DockerFs({ container, workingDir: opts.cwd }));
    computerProxy.setTarget(new DockerComputer({
      container,
      defaultCwd: opts.cwd,
      defaultTimeout: opts.defaultTimeout,
    }));
  }

  return {
    fs: fsProxy,
    computer: computerProxy,
    sandboxId: () => containerId,

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
      if (!autoCreated || !containerRef) return;
      try { await containerRef.stop(); } catch { /* may already be stopped */ }
      try { await containerRef.remove(); } catch { /* best-effort */ }
    },
  };
}

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
      sandbox = await SandboxClass.connect(reconnectId, {
        apiKey: opts.apiKey,
      });
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
      if (!autoCreated || !sandboxRef) return;
      if (typeof sandboxRef.kill === "function") {
        await sandboxRef.kill();
      }
    },
  };
}
