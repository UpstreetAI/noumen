// Docker sandbox binding.
//
// Importing this subpath is the "consent ceremony" that says you've
// installed `dockerode` as an optional peer dependency. The root barrel
// (`noumen`) intentionally does not re-export this module so that
// `import { Agent } from "noumen"` stays structurally lightweight.
//
//   import { DockerSandbox } from "noumen/docker";

export { DockerSandbox, type DockerSandboxOptions } from "./virtual/docker-sandbox.js";
export { DockerFs, type DockerFsOptions } from "./virtual/docker-fs.js";
export {
  DockerComputer,
  type DockerComputerOptions,
  type DockerContainer,
} from "./virtual/docker-computer.js";
