// Local sandbox binding (OS-level isolation via @anthropic-ai/sandbox-runtime).
//
// Importing this subpath pulls in the local sandbox factory and its adapter
// primitives. The root barrel (`noumen`) intentionally does not re-export
// this module so that `import { Agent } from "noumen"` stays structurally
// lightweight and every sandbox is opted into by import.
//
//   import { LocalSandbox } from "noumen/local";

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
