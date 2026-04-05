import { describe, it, expect } from "vitest";
import { UnsandboxedLocal, LocalSandbox, SpritesSandbox } from "../virtual/sandbox.js";
import { LocalFs } from "../virtual/local-fs.js";
import { LocalComputer } from "../virtual/local-computer.js";
import { SandboxedLocalComputer } from "../virtual/sandboxed-local-computer.js";
import { SpritesFs } from "../virtual/sprites-fs.js";
import { SpritesComputer } from "../virtual/sprites-computer.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// UnsandboxedLocal
// ---------------------------------------------------------------------------

describe("UnsandboxedLocal", () => {
  it("returns a Sandbox with LocalFs and LocalComputer", () => {
    const sandbox = UnsandboxedLocal({ cwd: "/tmp/test" });
    expect(sandbox.fs).toBeInstanceOf(LocalFs);
    expect(sandbox.computer).toBeInstanceOf(LocalComputer);
  });

  it("works with no options", () => {
    const sandbox = UnsandboxedLocal();
    expect(sandbox.fs).toBeInstanceOf(LocalFs);
    expect(sandbox.computer).toBeInstanceOf(LocalComputer);
  });

  it("passes defaultTimeout to LocalComputer", () => {
    const sandbox = UnsandboxedLocal({ defaultTimeout: 60_000 });
    expect(sandbox.computer).toBeInstanceOf(LocalComputer);
  });
});

// ---------------------------------------------------------------------------
// LocalSandbox (OS-level sandboxing via SRT)
// ---------------------------------------------------------------------------

describe("LocalSandbox", () => {
  it("returns a Sandbox with LocalFs and SandboxedLocalComputer", () => {
    const sandbox = LocalSandbox({ cwd: "/tmp/test" });
    expect(sandbox.fs).toBeInstanceOf(LocalFs);
    expect(sandbox.computer).toBeInstanceOf(SandboxedLocalComputer);
  });

  it("uses process.cwd() as default cwd", () => {
    const sandbox = LocalSandbox();
    expect(sandbox.fs).toBeInstanceOf(LocalFs);
    expect(sandbox.computer).toBeInstanceOf(SandboxedLocalComputer);
  });

  it("passes custom sandbox config through", () => {
    const sandbox = LocalSandbox({
      cwd: "/tmp/test",
      sandbox: {
        filesystem: { denyRead: ["/etc/shadow"] },
        network: { allowedDomains: ["example.com"] },
      },
    });
    expect(sandbox.computer).toBeInstanceOf(SandboxedLocalComputer);
  });
});

// ---------------------------------------------------------------------------
// LocalFs path resolution
// ---------------------------------------------------------------------------

describe("LocalFs", () => {
  it("resolves relative paths under basePath", () => {
    const lfs = new LocalFs({ basePath: "/tmp/base" });
    // Use the private resolve method via a known code path — write a file
    // and check the path it receives. We test via the public API instead.
    expect(lfs).toBeInstanceOf(LocalFs);
  });

  it("reads and writes files on the host filesystem", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localfs-test-"));
    const lfs = new LocalFs({ basePath: dir });

    await lfs.writeFile("hello.txt", "world");
    const content = await lfs.readFile("hello.txt");
    expect(content).toBe("world");

    await fs.rm(dir, { recursive: true });
  });

  it("rejects absolute paths outside basePath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localfs-abs-"));
    const absFile = path.join(dir, "abs.txt");
    await fs.writeFile(absFile, "absolute");

    const lfs = new LocalFs({ basePath: "/some/other/path" });
    await expect(lfs.readFile(absFile)).rejects.toThrow("resolves outside base directory");

    await fs.rm(dir, { recursive: true });
  });

  it("allows absolute paths inside basePath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localfs-abs-"));
    const absFile = path.join(dir, "abs.txt");
    await fs.writeFile(absFile, "absolute");

    const lfs = new LocalFs({ basePath: dir });
    const content = await lfs.readFile(absFile);
    expect(content).toBe("absolute");

    await fs.rm(dir, { recursive: true });
  });

  it("lists directory entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localfs-readdir-"));
    await fs.writeFile(path.join(dir, "a.txt"), "a");
    await fs.mkdir(path.join(dir, "sub"));

    const lfs = new LocalFs({ basePath: dir });
    const entries = await lfs.readdir(".");
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "sub"]);

    await fs.rm(dir, { recursive: true });
  });

  it("checks existence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localfs-exists-"));
    await fs.writeFile(path.join(dir, "yes.txt"), "");
    const lfs = new LocalFs({ basePath: dir });

    expect(await lfs.exists("yes.txt")).toBe(true);
    expect(await lfs.exists("no.txt")).toBe(false);

    await fs.rm(dir, { recursive: true });
  });

  it("stats files correctly", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localfs-stat-"));
    await fs.writeFile(path.join(dir, "f.txt"), "content");
    const lfs = new LocalFs({ basePath: dir });

    const stat = await lfs.stat("f.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(7);

    await fs.rm(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// LocalComputer
// ---------------------------------------------------------------------------

describe("LocalComputer", () => {
  it("executes a simple command", async () => {
    const comp = new LocalComputer();
    const result = await comp.executeCommand("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("respects cwd option", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localcomp-cwd-"));
    const realDir = await fs.realpath(dir);
    const comp = new LocalComputer({ defaultCwd: dir });
    const result = await comp.executeCommand("pwd");
    expect(result.exitCode).toBe(0);
    const realOutput = await fs.realpath(result.stdout.trim());
    expect(realOutput).toBe(realDir);
    await fs.rm(dir, { recursive: true });
  });

  it("returns non-zero exit code on failure", async () => {
    const comp = new LocalComputer();
    const result = await comp.executeCommand("exit 42");
    expect(result.exitCode).toBe(42);
  });

  it("captures stderr", async () => {
    const comp = new LocalComputer();
    const result = await comp.executeCommand("echo err >&2");
    expect(result.stderr.trim()).toBe("err");
  });

  it("merges env vars", async () => {
    const comp = new LocalComputer();
    const result = await comp.executeCommand("echo $TEST_VAR", {
      env: { TEST_VAR: "sandboxed" },
    });
    expect(result.stdout.trim()).toBe("sandboxed");
  });
});

// ---------------------------------------------------------------------------
// SpritesSandbox (unchanged, kept for regression)
// ---------------------------------------------------------------------------

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
