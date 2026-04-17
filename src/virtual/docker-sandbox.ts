import type { Sandbox } from "./sandbox.js";
import { DockerFs } from "./docker-fs.js";
import { DockerComputer, type DockerContainer } from "./docker-computer.js";
import { createFsProxy, createComputerProxy } from "./proxy.js";

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
      try {
        await container.inspect();
      } catch {
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
      if (initPromise) {
        await initPromise.catch(() => {});
      }
      if (!autoCreated || !containerRef) return;
      try { await containerRef.stop(); } catch { /* may already be stopped */ }
      try { await containerRef.remove(); } catch { /* best-effort */ }
    },
  };
}
