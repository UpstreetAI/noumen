import type { VirtualFs } from "./fs.js";
import type { VirtualComputer } from "./computer.js";

/**
 * Bundled sandbox: a `VirtualFs` and `VirtualComputer` paired together.
 *
 * Every concrete backend lives on its own subpath so that importing `noumen`
 * never pulls a backend's optional peer deps into the module graph. Pick the
 * one you want:
 *
 *   import { LocalSandbox }     from "noumen/local"        // OS-level sandboxing
 *   import { UnsandboxedLocal } from "noumen/unsandboxed"  // raw host access
 *   import { DockerSandbox }    from "noumen/docker"       // requires `dockerode`
 *   import { E2BSandbox }       from "noumen/e2b"          // requires `e2b`
 *   import { FreestyleSandbox } from "noumen/freestyle"    // requires `freestyle-sandboxes`
 *   import { SshSandbox }       from "noumen/ssh"          // requires `ssh2`
 *   import { SpritesSandbox }   from "noumen/sprites"      // no peer dep
 *
 * You can also supply any object that satisfies this shape for custom
 * sandboxes (in-memory, custom cloud backends, etc.).
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
