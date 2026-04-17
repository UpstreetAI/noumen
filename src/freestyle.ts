// Freestyle sandbox binding.
//
// Importing this subpath is the "consent ceremony" that says you've
// installed `freestyle-sandboxes` as an optional peer dependency. The
// root barrel (`noumen`) intentionally does not re-export this module
// so that `import { Agent } from "noumen"` stays structurally
// lightweight.
//
//   import { FreestyleSandbox } from "noumen/freestyle";

export { FreestyleSandbox, type FreestyleSandboxOptions } from "./virtual/freestyle-sandbox.js";
export { FreestyleFs, type FreestyleFsOptions } from "./virtual/freestyle-fs.js";
export {
  FreestyleComputer,
  type FreestyleComputerOptions,
  type FreestyleVmInstance,
} from "./virtual/freestyle-computer.js";
