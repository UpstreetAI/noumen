import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { VirtualFs } from "../virtual/fs.js";
import type { VirtualComputer } from "../virtual/computer.js";

// ---------------------------------------------------------------------------
// Proxy helpers — test that uninitialised proxies throw and that init() wires
// them to real implementations.
// ---------------------------------------------------------------------------

describe("SpritesSandbox auto-creation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("explicit spriteName attaches immediately (no init needed)", async () => {
    const { SpritesSandbox } = await import("../virtual/sandbox.js");

    const sandbox = SpritesSandbox({
      token: "tok",
      spriteName: "pre-existing",
    });

    expect(sandbox.sandboxId?.()).toBe("pre-existing");
    expect(sandbox.init).toBeUndefined();
  });

  it("omitting spriteName returns lazy sandbox with init()", async () => {
    const { SpritesSandbox } = await import("../virtual/sandbox.js");

    const sandbox = SpritesSandbox({ token: "tok" });

    expect(sandbox.init).toBeTypeOf("function");
    expect(sandbox.sandboxId?.()).toBeUndefined();
  });

  it("proxy methods throw before init()", async () => {
    const { SpritesSandbox } = await import("../virtual/sandbox.js");

    const sandbox = SpritesSandbox({ token: "tok" });

    expect(() => sandbox.fs.readFile("/test")).toThrow(
      "Sandbox not initialized",
    );
    expect(() => sandbox.computer.executeCommand("echo hi")).toThrow(
      "Sandbox not initialized",
    );
  });

  it("init() auto-creates via POST and sets sandboxId", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("{}"),
      json: () => Promise.resolve({ id: "sprite-1", name: "noumen-1234" }),
    }) as unknown as typeof fetch;

    const { SpritesSandbox } = await import("../virtual/sandbox.js");

    const sandbox = SpritesSandbox({ token: "tok" });
    await sandbox.init!();

    expect(sandbox.sandboxId?.()).toBeDefined();
    expect(typeof sandbox.sandboxId?.()).toBe("string");

    const calls = (globalThis.fetch as any).mock.calls;
    const createCall = calls.find(
      (c: any[]) =>
        c[1]?.method === "POST" && c[0].includes("/v1/sprites"),
    );
    expect(createCall).toBeDefined();
  });

  it("init(reconnectId) skips creation and uses provided ID", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const { SpritesSandbox } = await import("../virtual/sandbox.js");

    const sandbox = SpritesSandbox({ token: "tok" });
    await sandbox.init!("existing-sprite-name");

    expect(sandbox.sandboxId?.()).toBe("existing-sprite-name");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("init() is idempotent (single-flight)", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return { ok: true, text: () => Promise.resolve("{}") };
    }) as unknown as typeof fetch;

    const { SpritesSandbox } = await import("../virtual/sandbox.js");
    const sandbox = SpritesSandbox({ token: "tok" });

    const p1 = sandbox.init!();
    const p2 = sandbox.init!();
    await Promise.all([p1, p2]);

    const postCalls = (globalThis.fetch as any).mock.calls.filter(
      (c: any[]) => c[1]?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
  });

  it("dispose() deletes auto-created sprite", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("{}"),
    }) as unknown as typeof fetch;

    const { SpritesSandbox } = await import("../virtual/sandbox.js");

    const sandbox = SpritesSandbox({ token: "tok" });
    await sandbox.init!();

    (globalThis.fetch as any).mockClear();

    await sandbox.dispose!();

    const deleteCall = (globalThis.fetch as any).mock.calls.find(
      (c: any[]) => c[1]?.method === "DELETE",
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toContain("/v1/sprites/");
  });

  it("dispose() is a no-op for reconnected sandbox", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const { SpritesSandbox } = await import("../virtual/sandbox.js");

    const sandbox = SpritesSandbox({ token: "tok" });
    await sandbox.init!("user-provided");

    await sandbox.dispose!();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("proxy delegates to SpritesFs after init()", async () => {
    const readMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("file contents"),
    });
    const createMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("{}"),
    });

    globalThis.fetch = vi.fn().mockImplementation(
      async (url: string, opts?: any) => {
        if (opts?.method === "POST" && url.includes("/v1/sprites") && !url.includes("/exec") && !url.includes("/fs")) {
          return createMock();
        }
        return readMock();
      },
    ) as unknown as typeof fetch;

    const { SpritesSandbox } = await import("../virtual/sandbox.js");
    const sandbox = SpritesSandbox({ token: "tok" });
    await sandbox.init!();

    const content = await sandbox.fs.readFile("/test.txt");
    expect(content).toBe("file contents");
  });

  it("namePrefix is used for generated names", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("{}"),
    }) as unknown as typeof fetch;

    const { SpritesSandbox } = await import("../virtual/sandbox.js");
    const sandbox = SpritesSandbox({ token: "tok", namePrefix: "myapp-" });
    await sandbox.init!();

    expect(sandbox.sandboxId?.()).toMatch(/^myapp-/);
  });
});

// ---------------------------------------------------------------------------
// DockerSandbox auto-creation
// ---------------------------------------------------------------------------

describe("DockerSandbox", () => {
  it("explicit container attaches immediately", async () => {
    const { DockerSandbox } = await import("../virtual/sandbox.js");

    const mockContainer = {
      id: "abc123",
      exec: vi.fn(),
    };

    const sandbox = DockerSandbox({ container: mockContainer as any });
    expect(sandbox.sandboxId?.()).toBe("abc123");
    expect(sandbox.init).toBeUndefined();
  });

  it("throws when neither container nor image provided", async () => {
    const { DockerSandbox } = await import("../virtual/sandbox.js");

    expect(() => DockerSandbox({} as any)).toThrow(
      "requires either `container` or `image`",
    );
  });

  it("returns lazy sandbox when image is provided", async () => {
    const { DockerSandbox } = await import("../virtual/sandbox.js");

    const sandbox = DockerSandbox({ image: "ubuntu:22.04" });
    expect(sandbox.init).toBeTypeOf("function");
    expect(sandbox.sandboxId?.()).toBeUndefined();
  });

  it("proxy throws before init()", async () => {
    const { DockerSandbox } = await import("../virtual/sandbox.js");

    const sandbox = DockerSandbox({ image: "ubuntu:22.04" });

    expect(() => sandbox.fs.readFile("/test")).toThrow(
      "Sandbox not initialized",
    );
  });
});

// ---------------------------------------------------------------------------
// E2BSandbox auto-creation
// ---------------------------------------------------------------------------

describe("E2BSandbox", () => {
  it("explicit sandbox attaches immediately", async () => {
    const { E2BSandbox } = await import("../virtual/sandbox.js");

    const mockSandbox = {
      sandboxId: "e2b-123",
      commands: { run: vi.fn() },
      files: {
        read: vi.fn(),
        write: vi.fn(),
        remove: vi.fn(),
        makeDir: vi.fn(),
        list: vi.fn(),
        exists: vi.fn(),
        getInfo: vi.fn(),
      },
    };

    const sandbox = E2BSandbox({ sandbox: mockSandbox as any });
    expect(sandbox.sandboxId?.()).toBe("e2b-123");
    expect(sandbox.init).toBeUndefined();
  });

  it("returns lazy sandbox when no instance provided", async () => {
    const { E2BSandbox } = await import("../virtual/sandbox.js");

    const sandbox = E2BSandbox({ template: "base" });
    expect(sandbox.init).toBeTypeOf("function");
    expect(sandbox.sandboxId?.()).toBeUndefined();
  });

  it("proxy throws before init()", async () => {
    const { E2BSandbox } = await import("../virtual/sandbox.js");

    const sandbox = E2BSandbox({ template: "base" });

    expect(() => sandbox.fs.readFile("/test")).toThrow(
      "Sandbox not initialized",
    );
  });
});

// ---------------------------------------------------------------------------
// SessionStorage.deleteSession
// ---------------------------------------------------------------------------

describe("SessionStorage.deleteSession", () => {
  it("deletes the session file", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const { LocalFs } = await import("../virtual/local-fs.js");
    const { SessionStorage } = await import("../session/storage.js");

    const dir = path.join(os.tmpdir(), `noumen-del-session-${Date.now()}`);
    const localFs = new LocalFs({ basePath: dir });
    const storage = new SessionStorage(localFs, "sessions");

    await storage.appendMetadata("sess-1", "key", "value");
    expect(await storage.sessionExists("sess-1")).toBe(true);

    await storage.deleteSession("sess-1");
    expect(await storage.sessionExists("sess-1")).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is a no-op for non-existent session", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const { LocalFs } = await import("../virtual/local-fs.js");
    const { SessionStorage } = await import("../session/storage.js");

    const dir = path.join(os.tmpdir(), `noumen-del-noop-${Date.now()}`);
    const localFs = new LocalFs({ basePath: dir });
    const storage = new SessionStorage(localFs, "sessions");

    await expect(storage.deleteSession("nonexistent")).resolves.toBeUndefined();

    await fs.rm(dir, { recursive: true, force: true });
  });
});
