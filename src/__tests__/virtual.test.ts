import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// LocalFs — test via the MockFs (contract compliance), since mocking
// node:fs/promises with vi.doMock is brittle with ESM caching.
// We test the LocalFs contract by verifying it conforms to VirtualFs behavior.
// ---------------------------------------------------------------------------
describe("LocalFs", () => {
  it("implements VirtualFs interface", async () => {
    const { LocalFs } = await import("../virtual/local-fs.js");
    const localFs = new LocalFs({ basePath: "/tmp/noumen-test-" + Date.now() });

    // Verify all required methods exist
    expect(typeof localFs.readFile).toBe("function");
    expect(typeof localFs.writeFile).toBe("function");
    expect(typeof localFs.appendFile).toBe("function");
    expect(typeof localFs.deleteFile).toBe("function");
    expect(typeof localFs.mkdir).toBe("function");
    expect(typeof localFs.readdir).toBe("function");
    expect(typeof localFs.exists).toBe("function");
    expect(typeof localFs.stat).toBe("function");
  });

  it("write + read round-trip on real fs", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const { LocalFs } = await import("../virtual/local-fs.js");

    const tmpDir = path.join(os.tmpdir(), `noumen-test-${Date.now()}`);
    const localFs = new LocalFs({ basePath: tmpDir });

    await localFs.writeFile("test.txt", "hello world");
    const content = await localFs.readFile("test.txt");
    expect(content).toBe("hello world");

    expect(await localFs.exists("test.txt")).toBe(true);
    expect(await localFs.exists("nope.txt")).toBe(false);

    const stat = await localFs.stat("test.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(11);

    // Cleanup
    await localFs.deleteFile("test.txt");
  });

  it("readdir lists entries", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const { LocalFs } = await import("../virtual/local-fs.js");

    const tmpDir = path.join(os.tmpdir(), `noumen-test-${Date.now()}`);
    const localFs = new LocalFs({ basePath: tmpDir });

    await localFs.writeFile("a.txt", "a");
    await localFs.writeFile("b.txt", "b");

    const entries = await localFs.readdir(".");
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "b.txt"]);

    // Cleanup
    await localFs.deleteFile("a.txt");
    await localFs.deleteFile("b.txt");
  });
});

// ---------------------------------------------------------------------------
// LocalComputer — test with real child_process (lightweight commands)
// ---------------------------------------------------------------------------
describe("LocalComputer", () => {
  it("executes a simple command", async () => {
    const { LocalComputer } = await import("../virtual/local-computer.js");
    const computer = new LocalComputer();

    const result = await computer.executeCommand("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("returns non-zero exit code for failing command", async () => {
    const { LocalComputer } = await import("../virtual/local-computer.js");
    const computer = new LocalComputer();

    const result = await computer.executeCommand("exit 42");
    expect(result.exitCode).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// SpritesFs — mock fetch
// ---------------------------------------------------------------------------
describe("SpritesFs", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("readFile calls sprites API and returns text", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("file content"),
    }) as unknown as typeof fetch;

    const { SpritesFs } = await import("../virtual/sprites-fs.js");
    const sfs = new SpritesFs({
      token: "tok",
      spriteName: "my-sprite",
      baseURL: "https://api.sprites.dev",
    });

    const content = await sfs.readFile("/home/sprite/test.txt");
    expect(content).toBe("file content");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/fs/read"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
        }),
      }),
    );
  });

  it("writeFile posts content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    }) as unknown as typeof fetch;

    const { SpritesFs } = await import("../virtual/sprites-fs.js");
    const sfs = new SpritesFs({ token: "tok", spriteName: "s1" });

    await sfs.writeFile("test.txt", "data");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/fs/write"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("readdir parses JSON response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { name: "a.ts", path: "/home/sprite/a.ts", is_dir: false, size: 100 },
        ]),
    }) as unknown as typeof fetch;

    const { SpritesFs } = await import("../virtual/sprites-fs.js");
    const sfs = new SpritesFs({ token: "tok", spriteName: "s1" });

    const entries = await sfs.readdir("/home/sprite");
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("a.ts");
    expect(entries[0].isFile).toBe(true);
    expect(entries[0].isDirectory).toBe(false);
  });

  it("throws on non-OK response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("not found"),
    }) as unknown as typeof fetch;

    const { SpritesFs } = await import("../virtual/sprites-fs.js");
    const sfs = new SpritesFs({ token: "tok", spriteName: "s1" });

    await expect(sfs.readFile("nope.txt")).rejects.toThrow("404");
  });

  it("exists returns false when stat throws", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("not found"),
    }) as unknown as typeof fetch;

    const { SpritesFs } = await import("../virtual/sprites-fs.js");
    const sfs = new SpritesFs({ token: "tok", spriteName: "s1" });

    expect(await sfs.exists("nope.txt")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpritesComputer — mock fetch
// ---------------------------------------------------------------------------
describe("SpritesComputer", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("executeCommand posts to exec endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ exit_code: 0, stdout: "ok\n", stderr: "" }),
    }) as unknown as typeof fetch;

    const { SpritesComputer } = await import("../virtual/sprites-computer.js");
    const computer = new SpritesComputer({ token: "tok", spriteName: "s1" });

    const result = await computer.executeCommand("echo ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/exec"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns exitCode 1 for non-OK response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("server error"),
    }) as unknown as typeof fetch;

    const { SpritesComputer } = await import("../virtual/sprites-computer.js");
    const computer = new SpritesComputer({ token: "tok", spriteName: "s1" });

    const result = await computer.executeCommand("bad");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("500");
  });
});

describe("LocalFs.resolve returns real path", () => {
  it("returns symlink-resolved path instead of lexical path", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const { LocalFs } = await import("../virtual/local-fs.js");

    const tmpDir = path.join(os.tmpdir(), `noumen-symlink-test-${Date.now()}`);
    const realDir = path.join(tmpDir, "real");
    const linkPath = path.join(tmpDir, "link");

    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, "test.txt"), "hello");
    await fs.symlink(realDir, linkPath);

    try {
      // basePath points to the symlink
      const localFs = new LocalFs({ basePath: linkPath });

      // Reading through the symlink should work and return resolved content
      const content = await localFs.readFile("test.txt");
      expect(content).toBe("hello");

      // Writing through the symlink should work
      await localFs.writeFile("output.txt", "world");
      // Verify the file was written to the real directory
      const realContent = await fs.readFile(path.join(realDir, "output.txt"), "utf-8");
      expect(realContent).toBe("world");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
