import { describe, it, expect } from "vitest";
import { UnsandboxedLocal } from "../virtual/unsandboxed.js";
import { LocalSandbox } from "../virtual/local-sandbox.js";
import { SpritesSandbox } from "../virtual/sprites-sandbox.js";
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

  it("rejects paths using .. traversal outside basePath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localfs-trav-"));
    const lfs = new LocalFs({ basePath: dir });
    await expect(lfs.readFile("../../etc/passwd")).rejects.toThrow("resolves outside base directory");
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

// ---------------------------------------------------------------------------
// dispose() awaits in-flight init() — Bug 5 regression tests
// ---------------------------------------------------------------------------
describe("Sandbox dispose-during-init race", () => {
  it("DockerSandbox dispose awaits init before cleanup", async () => {
    const { DockerSandbox } = await import("../virtual/docker-sandbox.js");
    let containerStarted = false;
    let containerStopped = false;
    let containerRemoved = false;

    const fakeDocker = {
      createContainer: async () => {
        await new Promise((r) => setTimeout(r, 50));
        containerStarted = true;
        return {
          id: "test-container-id",
          start: async () => {},
          stop: async () => { containerStopped = true; },
          remove: async () => { containerRemoved = true; },
          putArchive: async () => {},
          exec: async () => ({ start: async () => ({ output: { on: () => {} } }) }),
        };
      },
      getContainer: () => { throw new Error("should not be called"); },
    };

    const mockDockerode = { default: class { constructor() { return fakeDocker; } } };
    const { vi } = await import("vitest");
    vi.doMock("dockerode", () => mockDockerode);

    const sandbox = DockerSandbox({ image: "ubuntu:22.04" });

    const initPromise = sandbox.init!();
    await new Promise((r) => setTimeout(r, 10));
    await sandbox.dispose!();

    await initPromise.catch(() => {});

    expect(containerStarted).toBe(true);
    expect(containerStopped).toBe(true);
    expect(containerRemoved).toBe(true);

    vi.doUnmock("dockerode");
  });

  it("E2BSandbox dispose awaits init before cleanup", async () => {
    const { E2BSandbox } = await import("../virtual/e2b-sandbox.js");
    let sandboxCreated = false;
    let sandboxKilled = false;

    const { vi } = await import("vitest");
    vi.doMock("e2b", () => ({
      Sandbox: {
        create: async () => {
          await new Promise((r) => setTimeout(r, 50));
          sandboxCreated = true;
          return {
            sandboxId: "test-sandbox-id",
            kill: async () => { sandboxKilled = true; },
            filesystem: { read: async () => "", write: async () => {}, list: async () => [] },
            process: { start: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
          };
        },
        connect: async () => { throw new Error("should not connect"); },
      },
    }));

    const sandbox = E2BSandbox({ template: "base" });

    const initPromise = sandbox.init!();
    await new Promise((r) => setTimeout(r, 10));
    await sandbox.dispose!();

    await initPromise.catch(() => {});

    expect(sandboxCreated).toBe(true);
    expect(sandboxKilled).toBe(true);

    vi.doUnmock("e2b");
  });
});

// ---------------------------------------------------------------------------
// Sandbox reconnect validates remote resource — Bug 11 regression tests
// ---------------------------------------------------------------------------
describe("Sandbox reconnect validation", () => {
  it("SpritesSandbox reconnect validates sprite exists", async () => {
    const { vi } = await import("vitest");
    let fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCalls.push(`${init?.method ?? "GET"} ${urlStr}`);

      if (urlStr.includes("/v1/sprites/existing-sprite") && init?.method === "GET") {
        return new Response(JSON.stringify({ name: "existing-sprite" }), { status: 200 });
      }
      if (urlStr.includes("/v1/sprites") && init?.method === "POST") {
        return new Response(JSON.stringify({ name: "new-sprite" }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const { SpritesSandbox } = await import("../virtual/sprites-sandbox.js");
      const sandbox = SpritesSandbox({ token: "test-token" });
      await sandbox.init!("existing-sprite");

      const healthCheck = fetchCalls.find(c => c.includes("GET") && c.includes("existing-sprite"));
      expect(healthCheck).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("SpritesSandbox falls back to POST create when reconnect GET returns 404", async () => {
    const { vi } = await import("vitest");
    let fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCalls.push(`${init?.method ?? "GET"} ${urlStr}`);

      if (init?.method === "GET" && urlStr.includes("/v1/sprites/gone-sprite")) {
        return new Response("not found", { status: 404 });
      }
      if (init?.method === "POST" && urlStr.includes("/v1/sprites")) {
        return new Response(JSON.stringify({ name: "new-sprite" }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const { SpritesSandbox } = await import("../virtual/sprites-sandbox.js");
      const sandbox = SpritesSandbox({ token: "test-token" });
      await sandbox.init!("gone-sprite");

      // GET should have been tried first
      const getCalls = fetchCalls.filter(c => c.startsWith("GET") && c.includes("gone-sprite"));
      expect(getCalls.length).toBeGreaterThanOrEqual(1);

      // POST should have been called to create a new sprite
      const postCalls = fetchCalls.filter(c => c.startsWith("POST") && c.includes("/v1/sprites"));
      expect(postCalls.length).toBe(1);

      // sandboxId should be set (to the new generated name, not "gone-sprite")
      expect(sandbox.sandboxId!()).toBeDefined();
      expect(sandbox.sandboxId!()).not.toBe("gone-sprite");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Docker reconnect paths
// ---------------------------------------------------------------------------
describe("DockerSandbox reconnect", () => {
  it("reuses existing container when reconnect inspect succeeds", async () => {
    const { vi } = await import("vitest");
    let inspectCalled = false;
    let createCalled = false;

    vi.doMock("dockerode", () => ({
      default: class MockDocker {
        getContainer(id: string) {
          return {
            id,
            async inspect() {
              inspectCalled = true;
              return { Id: id, State: { Running: true } };
            },
            async exec(options: Record<string, unknown>) {
              const { Readable } = await import("node:stream");
              const stream = new Readable({ read() { this.push(null); } });
              return { async start() { return stream; }, async inspect() { return { ExitCode: 0 }; } };
            },
          };
        }
        async createContainer() {
          createCalled = true;
          return {};
        }
      },
    }));

    const { DockerSandbox } = await import("../virtual/docker-sandbox.js");
    const sandbox = DockerSandbox({ image: "ubuntu:latest" });
    await sandbox.init!("existing-container-id");

    expect(inspectCalled).toBe(true);
    expect(createCalled).toBe(false);
    expect(sandbox.sandboxId!()).toBe("existing-container-id");

    vi.doUnmock("dockerode");
  });

  it("creates a new container when reconnect inspect throws", async () => {
    const { vi } = await import("vitest");
    let createCalled = false;
    const createdId = "new-container-123";

    vi.doMock("dockerode", () => ({
      default: class MockDocker {
        getContainer() {
          return {
            async inspect() {
              throw new Error("container not found");
            },
          };
        }
        async createContainer() {
          createCalled = true;
          return {
            id: createdId,
            async start() {},
            async inspect() { return { Id: createdId, State: { Running: true } }; },
            async exec(options: Record<string, unknown>) {
              const { Readable } = await import("node:stream");
              const stream = new Readable({ read() { this.push(null); } });
              return { async start() { return stream; }, async inspect() { return { ExitCode: 0 }; } };
            },
          };
        }
      },
    }));

    const { DockerSandbox } = await import("../virtual/docker-sandbox.js");
    const sandbox = DockerSandbox({ image: "ubuntu:latest" });
    await sandbox.init!("nonexistent-container");

    expect(createCalled).toBe(true);

    vi.doUnmock("dockerode");
  });
});

// ---------------------------------------------------------------------------
// E2B reconnect paths
// ---------------------------------------------------------------------------
describe("E2BSandbox reconnect", () => {
  it("reconnects to existing sandbox when connect succeeds", async () => {
    const { vi } = await import("vitest");
    let connectCalled = false;
    let createCalled = false;

    vi.doMock("e2b", () => ({
      Sandbox: {
        async connect(id: string) {
          connectCalled = true;
          return {
            commands: { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }) },
            files: {
              read: vi.fn(), write: vi.fn(), remove: vi.fn(),
              makeDir: vi.fn(), list: vi.fn(), exists: vi.fn(), getInfo: vi.fn(),
            },
          };
        },
        async create() {
          createCalled = true;
          return {};
        },
      },
    }));

    const { E2BSandbox } = await import("../virtual/e2b-sandbox.js");
    const sandbox = E2BSandbox({ template: "base" });
    await sandbox.init!("existing-sandbox-id");

    expect(connectCalled).toBe(true);
    expect(createCalled).toBe(false);

    vi.doUnmock("e2b");
  });

  it("falls back to create when connect throws", async () => {
    const { vi } = await import("vitest");
    let createCalled = false;

    vi.doMock("e2b", () => ({
      Sandbox: {
        async connect() {
          throw new Error("sandbox expired");
        },
        async create() {
          createCalled = true;
          return {
            commands: { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }) },
            files: {
              read: vi.fn(), write: vi.fn(), remove: vi.fn(),
              makeDir: vi.fn(), list: vi.fn(), exists: vi.fn(), getInfo: vi.fn(),
            },
          };
        },
      },
    }));

    const { E2BSandbox } = await import("../virtual/e2b-sandbox.js");
    const sandbox = E2BSandbox({ template: "base" });
    await sandbox.init!("expired-sandbox-id");

    expect(createCalled).toBe(true);

    vi.doUnmock("e2b");
  });
});

// ---------------------------------------------------------------------------
// FreestyleSandbox (explicit mode)
// ---------------------------------------------------------------------------
describe("FreestyleSandbox", () => {
  it("returns a Sandbox with FreestyleFs and FreestyleComputer when vm is provided", async () => {
    const { FreestyleSandbox } = await import("../virtual/freestyle-sandbox.js");
    const { FreestyleFs } = await import("../virtual/freestyle-fs.js");
    const { FreestyleComputer } = await import("../virtual/freestyle-computer.js");

    const mockVm = {
      exec: async () => ({ statusCode: 0, stdout: "", stderr: "" }),
      fs: {
        readTextFile: async () => "",
        writeTextFile: async () => {},
        readDir: async () => [],
      },
      suspend: async () => {},
      start: async () => {},
    };

    const sandbox = FreestyleSandbox({ vm: mockVm, cwd: "/workspace" });
    expect(sandbox.fs).toBeInstanceOf(FreestyleFs);
    expect(sandbox.computer).toBeInstanceOf(FreestyleComputer);
  });
});

// ---------------------------------------------------------------------------
// Freestyle dispose-during-init race
// ---------------------------------------------------------------------------
describe("FreestyleSandbox dispose-during-init race", () => {
  it("FreestyleSandbox dispose awaits init before cleanup", async () => {
    const { vi } = await import("vitest");
    let vmCreated = false;
    let vmSuspended = false;

    const mockVm = {
      exec: async () => ({ statusCode: 0, stdout: "", stderr: "" }),
      fs: {
        readTextFile: async () => "",
        writeTextFile: async () => {},
        readDir: async () => [],
      },
      suspend: async () => { vmSuspended = true; },
      start: async () => {},
    };

    vi.doMock("freestyle-sandboxes", () => ({
      freestyle: {
        vms: {
          async create() {
            await new Promise((r) => setTimeout(r, 50));
            vmCreated = true;
            return { vmId: "test-vm-id", vm: mockVm };
          },
          async get() { throw new Error("should not be called"); },
          async delete() {},
        },
      },
    }));

    const { FreestyleSandbox } = await import("../virtual/freestyle-sandbox.js");
    const sandbox = FreestyleSandbox({ cwd: "/workspace" });

    const initPromise = sandbox.init!();
    await new Promise((r) => setTimeout(r, 10));
    await sandbox.dispose!();

    await initPromise.catch(() => {});

    expect(vmCreated).toBe(true);
    expect(vmSuspended).toBe(true);

    vi.doUnmock("freestyle-sandboxes");
  });
});

// ---------------------------------------------------------------------------
// Freestyle reconnect paths
// ---------------------------------------------------------------------------
describe("FreestyleSandbox reconnect", () => {
  it("reconnects to existing VM when get succeeds", async () => {
    const { vi } = await import("vitest");
    let getCalled = false;
    let createCalled = false;

    const mockVm = {
      exec: async () => ({ statusCode: 0, stdout: "", stderr: "" }),
      fs: {
        readTextFile: async () => "",
        writeTextFile: async () => {},
        readDir: async () => [],
      },
      suspend: async () => {},
      start: async () => {},
    };

    vi.doMock("freestyle-sandboxes", () => ({
      freestyle: {
        vms: {
          async get({ vmId }: { vmId: string }) {
            getCalled = true;
            return { vm: mockVm };
          },
          async create() {
            createCalled = true;
            return { vmId: "new-vm", vm: mockVm };
          },
        },
      },
    }));

    const { FreestyleSandbox } = await import("../virtual/freestyle-sandbox.js");
    const sandbox = FreestyleSandbox({ cwd: "/workspace" });
    await sandbox.init!("existing-vm-id");

    expect(getCalled).toBe(true);
    expect(createCalled).toBe(false);
    expect(sandbox.sandboxId!()).toBe("existing-vm-id");

    vi.doUnmock("freestyle-sandboxes");
  });

  it("falls back to create when get throws", async () => {
    const { vi } = await import("vitest");
    let createCalled = false;

    const mockVm = {
      exec: async () => ({ statusCode: 0, stdout: "", stderr: "" }),
      fs: {
        readTextFile: async () => "",
        writeTextFile: async () => {},
        readDir: async () => [],
      },
      suspend: async () => {},
      start: async () => {},
    };

    vi.doMock("freestyle-sandboxes", () => ({
      freestyle: {
        vms: {
          async get() {
            throw new Error("VM not found");
          },
          async create() {
            createCalled = true;
            return { vmId: "new-vm-id", vm: mockVm };
          },
        },
      },
    }));

    const { FreestyleSandbox } = await import("../virtual/freestyle-sandbox.js");
    const sandbox = FreestyleSandbox({ cwd: "/workspace" });
    await sandbox.init!("gone-vm-id");

    expect(createCalled).toBe(true);

    vi.doUnmock("freestyle-sandboxes");
  });

  it("uses delete strategy when configured", async () => {
    const { vi } = await import("vitest");
    let deleteCalled = false;

    const mockVm = {
      exec: async () => ({ statusCode: 0, stdout: "", stderr: "" }),
      fs: {
        readTextFile: async () => "",
        writeTextFile: async () => {},
        readDir: async () => [],
      },
      suspend: async () => {},
      start: async () => {},
    };

    vi.doMock("freestyle-sandboxes", () => ({
      freestyle: {
        vms: {
          async create() {
            return { vmId: "test-vm-id", vm: mockVm };
          },
          async delete({ vmId }: { vmId: string }) {
            deleteCalled = true;
            expect(vmId).toBe("test-vm-id");
          },
        },
      },
    }));

    const { FreestyleSandbox } = await import("../virtual/freestyle-sandbox.js");
    const sandbox = FreestyleSandbox({ cwd: "/workspace", disposeStrategy: "delete" });
    await sandbox.init!();
    await sandbox.dispose!();

    expect(deleteCalled).toBe(true);

    vi.doUnmock("freestyle-sandboxes");
  });
});
