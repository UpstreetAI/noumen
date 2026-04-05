import { describe, it, expect, vi } from "vitest";
import { E2BComputer, type E2BSandboxInstance } from "../virtual/e2b-computer.js";
import { E2BFs } from "../virtual/e2b-fs.js";

function createMockSandbox(overrides?: Partial<E2BSandboxInstance>): E2BSandboxInstance {
  return {
    commands: {
      run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
      ...overrides?.commands,
    },
    files: {
      read: vi.fn().mockResolvedValue("file content"),
      write: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue(undefined),
      makeDir: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue([]),
      exists: vi.fn().mockResolvedValue(true),
      getInfo: vi.fn().mockResolvedValue({ name: "test", path: "/test", size: 100, type: "file" }),
      ...overrides?.files,
    },
  };
}

describe("E2BComputer", () => {
  it("executes commands via sandbox.commands.run", async () => {
    const sandbox = createMockSandbox({
      commands: {
        run: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: "hello\n",
          stderr: "",
        }),
      },
    });

    const computer = new E2BComputer({ sandbox, defaultCwd: "/app" });
    const result = await computer.executeCommand("echo hello");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(sandbox.commands.run).toHaveBeenCalledWith("echo hello", {
      cwd: "/app",
      timeout: 30_000,
      envs: undefined,
    });
  });

  it("passes environment and timeout", async () => {
    const sandbox = createMockSandbox();
    const computer = new E2BComputer({ sandbox });

    await computer.executeCommand("env", {
      cwd: "/tmp",
      timeout: 5000,
      env: { FOO: "bar" },
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith("env", {
      cwd: "/tmp",
      timeout: 5000,
      envs: { FOO: "bar" },
    });
  });
});

describe("E2BFs", () => {
  it("reads files via sandbox.files.read", async () => {
    const sandbox = createMockSandbox({
      files: {
        ...createMockSandbox().files,
        read: vi.fn().mockResolvedValue("content here"),
      },
    });

    const fs = new E2BFs({ sandbox, workingDir: "/app" });
    const content = await fs.readFile("test.txt");

    expect(content).toBe("content here");
    expect(sandbox.files.read).toHaveBeenCalledWith("/app/test.txt", {
      format: "text",
    });
  });

  it("writes files via sandbox.files.write", async () => {
    const sandbox = createMockSandbox();
    const fs = new E2BFs({ sandbox });

    await fs.writeFile("/test.txt", "new content");
    expect(sandbox.files.write).toHaveBeenCalledWith("/test.txt", "new content");
  });

  it("deletes files via sandbox.files.remove", async () => {
    const sandbox = createMockSandbox();
    const fs = new E2BFs({ sandbox });

    await fs.deleteFile("/old.txt");
    expect(sandbox.files.remove).toHaveBeenCalledWith("/old.txt");
  });

  it("creates directories via sandbox.files.makeDir", async () => {
    const sandbox = createMockSandbox();
    const fs = new E2BFs({ sandbox });

    await fs.mkdir("/new/dir");
    expect(sandbox.files.makeDir).toHaveBeenCalledWith("/new/dir");
  });

  it("lists directory entries", async () => {
    const sandbox = createMockSandbox({
      files: {
        ...createMockSandbox().files,
        list: vi.fn().mockResolvedValue([
          { name: "file.ts", path: "/app/file.ts", type: "file", size: 200 },
          { name: "src", path: "/app/src", type: "dir" },
        ]),
      },
    });

    const fs = new E2BFs({ sandbox, workingDir: "/app" });
    const entries = await fs.readdir(".");

    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("file.ts");
    expect(entries[0].isFile).toBe(true);
    expect(entries[0].isDirectory).toBe(false);
    expect(entries[1].name).toBe("src");
    expect(entries[1].isDirectory).toBe(true);
  });

  it("checks existence via sandbox.files.exists", async () => {
    const sandbox = createMockSandbox({
      files: {
        ...createMockSandbox().files,
        exists: vi.fn().mockResolvedValue(false),
      },
    });

    const fs = new E2BFs({ sandbox });
    expect(await fs.exists("/nope.txt")).toBe(false);
  });

  it("gets file info via sandbox.files.getInfo", async () => {
    const modDate = new Date("2025-01-01");
    const sandbox = createMockSandbox({
      files: {
        ...createMockSandbox().files,
        getInfo: vi.fn().mockResolvedValue({
          name: "test.ts",
          path: "/test.ts",
          type: "file",
          size: 1024,
          modifiedTime: modDate,
        }),
      },
    });

    const fs = new E2BFs({ sandbox });
    const stat = await fs.stat("/test.ts");

    expect(stat.size).toBe(1024);
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.modifiedAt).toEqual(modDate);
  });

  it("resolves relative paths with workingDir", async () => {
    const sandbox = createMockSandbox();
    const fs = new E2BFs({ sandbox, workingDir: "/workspace" });

    await fs.readFile("relative/path.txt");
    expect(sandbox.files.read).toHaveBeenCalledWith(
      "/workspace/relative/path.txt",
      { format: "text" },
    );
  });

  it("allows absolute paths within working directory", async () => {
    const sandbox = createMockSandbox();
    const fs = new E2BFs({ sandbox, workingDir: "/workspace" });

    await fs.readFile("/workspace/subdir/file.txt");
    expect(sandbox.files.read).toHaveBeenCalledWith(
      "/workspace/subdir/file.txt",
      { format: "text" },
    );
  });

  it("rejects absolute paths outside working directory", async () => {
    const sandbox = createMockSandbox();
    const fs = new E2BFs({ sandbox, workingDir: "/workspace" });

    await expect(fs.readFile("/etc/shadow")).rejects.toThrow("outside working directory");
  });
});
