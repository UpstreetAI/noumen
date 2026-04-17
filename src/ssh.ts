// SSH sandbox binding.
//
// Importing this subpath is the "consent ceremony" that says you've
// installed `ssh2` as an optional peer dependency. The root barrel
// (`noumen`) intentionally does not re-export this module so that
// `import { Agent } from "noumen"` stays structurally lightweight.
//
//   import { SshSandbox } from "noumen/ssh";

export { SshSandbox, type SshSandboxOptions } from "./virtual/ssh-sandbox.js";
export { SshFs, type SshFsOptions } from "./virtual/ssh-fs.js";
export {
  SshComputer,
  type SshComputerOptions,
  type SshClient,
  type SshSftpSession,
  type SshChannel,
} from "./virtual/ssh-computer.js";
