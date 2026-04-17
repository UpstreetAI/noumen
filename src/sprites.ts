// Sprites sandbox binding.
//
// Sprites has no peer dep (it uses global `fetch`), but it lives on a
// subpath to keep the root barrel uniform: every remote sandbox backend
// is an opt-in import.
//
//   import { SpritesSandbox } from "noumen/sprites";

export { SpritesSandbox, type SpritesSandboxOptions } from "./virtual/sprites-sandbox.js";
export { SpritesFs, type SpritesFsOptions } from "./virtual/sprites-fs.js";
export { SpritesComputer, type SpritesComputerOptions } from "./virtual/sprites-computer.js";
