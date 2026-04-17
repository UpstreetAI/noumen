import type { Sandbox } from "./sandbox.js";
import { SshFs } from "./ssh-fs.js";
import { SshComputer, type SshClient } from "./ssh-computer.js";
import { createFsProxy, createComputerProxy } from "./proxy.js";

export interface SshSandboxOptions {
  /**
   * A pre-connected ssh2 Client instance. When provided the sandbox uses
   * this client directly — no auto-connect occurs and `dispose()` will
   * **not** call `client.end()`.
   *
   * When omitted, a new ssh2 Client is created and connected on the first
   * `init()` call using `host`, `port`, `username`, and the provided
   * credentials. The client is ended when `dispose()` is called.
   */
  client?: SshClient;
  /**
   * SSH hostname. Required when `client` is omitted; ignored when `client`
   * is provided.
   */
  host?: string;
  /** SSH port (default: 22). Only used during auto-connect. */
  port?: number;
  /** SSH username (default: "root"). Only used during auto-connect. */
  username?: string;
  /** Password for password-based authentication. Only used during auto-connect. */
  password?: string;
  /** Private key for key-based authentication (PEM string or Buffer). Only used during auto-connect. */
  privateKey?: string | Buffer;
  /** Passphrase for an encrypted private key. Only used during auto-connect. */
  passphrase?: string;
  /** Working directory on the remote host. */
  cwd?: string;
  /** Default timeout (ms) for shell commands. */
  defaultTimeout?: number;
}

/**
 * Create a `Sandbox` backed by a remote host over SSH.
 * Requires `ssh2` as an optional peer dependency.
 *
 * **Auto-connect:** When `client` is omitted and `host` is provided,
 * an ssh2 Client is created and connected lazily on the first `init()`
 * call. The connection identifier (`host:port`) is available through
 * `sandboxId()` for session persistence.
 *
 * **Explicit client:** When `client` is provided, `init()` binds it
 * immediately. `dispose()` is a no-op — the caller owns the client's
 * lifecycle.
 *
 * @example
 * ```ts
 * // Auto-connect with private key
 * const sandbox = SshSandbox({
 *   host: "dev.example.com",
 *   username: "deploy",
 *   privateKey: fs.readFileSync("~/.ssh/id_ed25519"),
 *   cwd: "/home/deploy/project",
 * });
 *
 * // Explicit client (lifecycle managed externally)
 * const sandbox = SshSandbox({ client: myConnectedClient, cwd: "/workspace" });
 * ```
 */
export function SshSandbox(opts: SshSandboxOptions): Sandbox {
  if (opts.client) {
    const c = opts.client;
    return {
      fs: new SshFs({ client: c, workingDir: opts.cwd }),
      computer: new SshComputer({
        client: c,
        defaultCwd: opts.cwd,
        defaultTimeout: opts.defaultTimeout,
      }),
      sandboxId: () =>
        opts.host ? `${opts.host}:${opts.port ?? 22}` : undefined,
    };
  }

  if (!opts.host) {
    throw new Error("SshSandbox requires either `client` or `host`");
  }

  const fsProxy = createFsProxy();
  const computerProxy = createComputerProxy();
  const identifier = `${opts.host}:${opts.port ?? 22}`;
  let clientRef: SshClient | null = null;
  let autoCreated = false;
  let initPromise: Promise<void> | null = null;

  async function doInit(): Promise<void> {
    const modName = "ssh2";
    const ssh2 = await import(/* webpackIgnore: true */ modName);
    const ClientClass =
      (ssh2 as any).Client ?? (ssh2 as any).default?.Client;
    if (!ClientClass) {
      throw new Error(
        "Could not resolve Client class from 'ssh2' package",
      );
    }

    const client: SshClient = new ClientClass();
    await new Promise<void>((resolve, reject) => {
      client.on("ready", () => resolve());
      client.on("error", (err: Error) => reject(err));
      (client as any).connect({
        host: opts.host,
        port: opts.port ?? 22,
        username: opts.username ?? "root",
        password: opts.password,
        privateKey: opts.privateKey,
        passphrase: opts.passphrase,
      });
    });

    clientRef = client;
    autoCreated = true;
    fsProxy.setTarget(new SshFs({ client, workingDir: opts.cwd }));
    computerProxy.setTarget(
      new SshComputer({
        client,
        defaultCwd: opts.cwd,
        defaultTimeout: opts.defaultTimeout,
      }),
    );
  }

  return {
    fs: fsProxy,
    computer: computerProxy,
    sandboxId: () => identifier,

    init(): Promise<void> {
      if (!initPromise) {
        initPromise = doInit().catch((err) => {
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
      if (!autoCreated || !clientRef) return;
      try {
        clientRef.end();
      } catch {
        /* best-effort */
      }
    },
  };
}
