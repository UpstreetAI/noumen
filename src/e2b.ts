// E2B sandbox binding.
//
// Importing this subpath is the "consent ceremony" that says you've
// installed `e2b` as an optional peer dependency. The root barrel
// (`noumen`) intentionally does not re-export this module so that
// `import { Agent } from "noumen"` stays structurally lightweight.
//
//   import { E2BSandbox } from "noumen/e2b";

export { E2BSandbox, type E2BSandboxOptions } from "./virtual/e2b-sandbox.js";
export { E2BFs, type E2BFsOptions } from "./virtual/e2b-fs.js";
export {
  E2BComputer,
  type E2BComputerOptions,
  type E2BSandboxInstance,
} from "./virtual/e2b-computer.js";
