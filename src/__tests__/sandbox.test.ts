import { describe, it, expect } from "vitest";
import { LocalSandbox, SpritesSandbox } from "../virtual/sandbox.js";
import { LocalFs } from "../virtual/local-fs.js";
import { LocalComputer } from "../virtual/local-computer.js";
import { SpritesFs } from "../virtual/sprites-fs.js";
import { SpritesComputer } from "../virtual/sprites-computer.js";

describe("LocalSandbox", () => {
  it("returns a Sandbox with LocalFs and LocalComputer", () => {
    const sandbox = LocalSandbox({ cwd: "/tmp/test" });
    expect(sandbox.fs).toBeInstanceOf(LocalFs);
    expect(sandbox.computer).toBeInstanceOf(LocalComputer);
  });

  it("works with no options", () => {
    const sandbox = LocalSandbox();
    expect(sandbox.fs).toBeInstanceOf(LocalFs);
    expect(sandbox.computer).toBeInstanceOf(LocalComputer);
  });

  it("passes defaultTimeout to LocalComputer", () => {
    const sandbox = LocalSandbox({ defaultTimeout: 60_000 });
    expect(sandbox.computer).toBeInstanceOf(LocalComputer);
  });
});

describe("SpritesSandbox", () => {
  it("returns a Sandbox with SpritesFs and SpritesComputer", () => {
    const sandbox = SpritesSandbox({
      token: "test-token",
      spriteName: "my-sprite",
    });
    expect(sandbox.fs).toBeInstanceOf(SpritesFs);
    expect(sandbox.computer).toBeInstanceOf(SpritesComputer);
  });

  it("passes through optional config", () => {
    const sandbox = SpritesSandbox({
      token: "test-token",
      spriteName: "my-sprite",
      baseURL: "https://custom.api.dev",
      workingDir: "/workspace",
    });
    expect(sandbox.fs).toBeInstanceOf(SpritesFs);
    expect(sandbox.computer).toBeInstanceOf(SpritesComputer);
  });
});
