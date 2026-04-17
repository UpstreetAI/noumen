import type { VirtualFs } from "./fs.js";
import type { VirtualComputer } from "./computer.js";

/**
 * Thin forwarding wrappers whose inner target is set by a sandbox factory's
 * `init()`. Methods throw until the target is bound.
 *
 * These proxies let remote sandbox factories return a `Sandbox` synchronously
 * while provisioning the real backend lazily inside `init()`. Consumers hold
 * the proxy reference and get transparent forwarding once `setTarget` fires.
 */

export type FsProxySetter = { setTarget(target: VirtualFs): void };
export type ComputerProxySetter = { setTarget(target: VirtualComputer): void };

export function uninitError(): never {
  throw new Error(
    "Sandbox not initialized — call init() or pass a pre-created resource",
  );
}

export function createFsProxy(): VirtualFs & FsProxySetter {
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

export function createComputerProxy(): VirtualComputer & ComputerProxySetter {
  let inner: VirtualComputer | null = null;
  const get = (): VirtualComputer => inner ?? uninitError();
  return {
    setTarget(target: VirtualComputer) { inner = target; },
    executeCommand: (...args) => get().executeCommand(...args),
  };
}
