import type { Sandbox } from "./sandbox.js";
import { SpritesFs } from "./sprites-fs.js";
import { SpritesComputer } from "./sprites-computer.js";
import { createFsProxy, createComputerProxy } from "./proxy.js";

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
    let name = reconnectId ?? `${opts.namePrefix ?? "noumen-"}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let needsCreate = !reconnectId;

    if (reconnectId) {
      const check = await fetch(`${baseURL}/v1/sprites/${reconnectId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${opts.token}` },
      });
      if (!check.ok) {
        name = `${opts.namePrefix ?? "noumen-"}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        needsCreate = true;
      }
    }

    if (needsCreate) {
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
      if (initPromise) {
        await initPromise.catch(() => {});
      }
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
