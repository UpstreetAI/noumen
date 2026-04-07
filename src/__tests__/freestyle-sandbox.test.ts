import { describe, it, expect, vi } from "vitest";
import { FreestyleComputer, type FreestyleVmInstance } from "../virtual/freestyle-computer.js";
import { FreestyleFs } from "../virtual/freestyle-fs.js";

function createMockVm(overrides?: Partial<FreestyleVmInstance>): FreestyleVmInstance {
  return {
    exec: vi.fn().mockResolvedValue({ statusCode: 0, stdout: "", stderr: "" }),
    fs: {
      readTextFile: vi.fn().mockResolvedValue("file content"),
      writeTextFile: vi.fn().mockResolvedValue(undefined),
      readDir: vi.fn().mockResolvedValue([]),
      ...overrides?.fs,
    },
    suspend: vi.fn().mockResolvedValue({}),
    start: vi.fn().mockResolvedValue({}),
    ...overrides,
    // re-apply fs after spread so partial overrides merge correctly
    ...(overrides?.fs ? { fs: { ...createDefaultFs(), ...overrides.fs } } : {}),
  };
}

function createDefaultFs(): FreestyleVmInstance["fs"] {
  return {
    readTextFile: vi.fn().mockResolvedValue("file content"),
    writeTextFile: vi.fn().mockResolvedValue(undefined),
    readDir: vi.fn().mockResolvedValue([]),
  };
}

describe("FreestyleComputer", () => {
  it("executes commands via vm.exec", async () => {
    const vm = createMockVm({
      exec: vi.fn().mockResolvedValue({
        statusCode: 0,
        stdout: "hello\n",
        stderr: "",
      }),
    });

    const computer = new FreestyleComputer({ vm, defaultCwd: "/app" });
    const result = await computer.executeCommand("echo hello");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(vm.exec).toHaveBeenCalledWith("echo hello", {
      cwd: "/app",
      timeout: 30_000,
    });
  });

  it("passes cwd and timeout overrides", async () => {
    const vm = createMockVm();
    const computer = new FreestyleComputer({ vm });

    await computer.executeCommand("env", {
      cwd: "/tmp",
      timeout: 5000,
    });

    expect(vm.exec).toHaveBeenCalledWith("env", {
      cwd: "/tmp",
      timeout: 5000,
    });
  });

  it("coalesces null stdout/stderr to empty strings", async () => {
    const vm = createMockVm({
      exec: vi.fn().mockResolvedValue({
        statusCode: 0,
        stdout: null,
        stderr: null,
      }),
    });

    const computer = new FreestyleComputer({ vm });
    const result = await computer.executeCommand("true");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("coalesces null statusCode to exit code 1", async () => {
    const vm = createMockVm({
      exec: vi.fn().mockResolvedValue({
        statusCode: null,
        stdout: "",
        stderr: "fail",
      }),
    });

    const computer = new FreestyleComputer({ vm });
    const result = await computer.executeCommand("false");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("fail");
  });
});

describe("FreestyleFs", () => {
  it("reads files via vm.fs.readTextFile", async () => {
    const vm = createMockVm({
      fs: { readTextFile: vi.fn().mockResolvedValue("content here") } as any,
    });

    const fs = new FreestyleFs({ vm, workingDir: "/app" });
    const content = await fs.readFile("test.txt");

    expect(content).toBe("content here");
    expect(vm.fs.readTextFile).toHaveBeenCalledWith("/app/test.txt");
  });

  it("writes files via vm.fs.writeTextFile", async () => {
    const vm = createMockVm();
    const fs = new FreestyleFs({ vm });

    await fs.writeFile("/test.txt", "new content");
    expect(vm.fs.writeTextFile).toHaveBeenCalledWith("/test.txt", "new content");
  });

  it("deletes files via vm.exec rm", async () => {
    const vm = createMockVm();
    const fs = new FreestyleFs({ vm });

    await fs.deleteFile("/old.txt");
    expect(vm.exec).toHaveBeenCalledWith(expect.stringContaining("rm -f"));
  });

  it("deletes recursively with -rf flag", async () => {
    const vm = createMockVm();
    const fs = new FreestyleFs({ vm });

    await fs.deleteFile("/dir", { recursive: true });
    expect(vm.exec).toHaveBeenCalledWith(expect.stringContaining("rm -rf"));
  });

  it("creates directories via vm.exec mkdir", async () => {
    const vm = createMockVm();
    const fs = new FreestyleFs({ vm });

    await fs.mkdir("/new/dir", { recursive: true });
    expect(vm.exec).toHaveBeenCalledWith(expect.stringContaining("mkdir -p"));
  });

  it("lists directory entries via vm.fs.readDir", async () => {
    const vm = createMockVm({
      fs: {
        readDir: vi.fn().mockResolvedValue([
          { name: "file.ts", kind: "file" },
          { name: "src", kind: "dir" },
        ]),
      } as any,
    });

    const fs = new FreestyleFs({ vm, workingDir: "/app" });
    const entries = await fs.readdir(".");

    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("file.ts");
    expect(entries[0].isFile).toBe(true);
    expect(entries[0].isDirectory).toBe(false);
    expect(entries[1].name).toBe("src");
    expect(entries[1].isDirectory).toBe(true);
  });

  it("checks existence via vm.exec test -e", async () => {
    const vm = createMockVm({
      exec: vi.fn().mockResolvedValue({ statusCode: 0, stdout: "", stderr: "" }),
    });

    const fs = new FreestyleFs({ vm });
    expect(await fs.exists("/yes.txt")).toBe(true);
  });

  it("returns false for non-existent files", async () => {
    const vm = createMockVm({
      exec: vi.fn().mockResolvedValue({ statusCode: 1, stdout: "", stderr: "" }),
    });

    const fs = new FreestyleFs({ vm });
    expect(await fs.exists("/nope.txt")).toBe(false);
  });

  it("stats files via vm.exec stat -c", async () => {
    const vm = createMockVm({
      exec: vi.fn().mockResolvedValue({
        statusCode: 0,
        stdout: "1024\tregular file\t0\t1700000000\n",
        stderr: "",
      }),
    });

    const fs = new FreestyleFs({ vm });
    const stat = await fs.stat("/test.ts");

    expect(stat.size).toBe(1024);
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.modifiedAt).toEqual(new Date(1700000000 * 1000));
  });

  it("stats directories correctly", async () => {
    const vm = createMockVm({
      exec: vi.fn().mockResolvedValue({
        statusCode: 0,
        stdout: "4096\tdirectory\t1690000000\t1700000000\n",
        stderr: "",
      }),
    });

    const fs = new FreestyleFs({ vm });
    const stat = await fs.stat("/src");

    expect(stat.isDirectory).toBe(true);
    expect(stat.isFile).toBe(false);
    expect(stat.createdAt).toEqual(new Date(1690000000 * 1000));
  });

  it("appends files via vm.exec base64 pipe", async () => {
    const vm = createMockVm();
    const fs = new FreestyleFs({ vm });

    await fs.appendFile("/log.txt", "new line\n");
    expect(vm.exec).toHaveBeenCalledWith(expect.stringContaining("base64 -d >>"));
  });

  it("reads binary files via vm.exec base64", async () => {
    const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const vm = createMockVm({
      exec: vi.fn().mockResolvedValue({
        statusCode: 0,
        stdout: binaryContent.toString("base64") + "\n",
        stderr: "",
      }),
    });

    const fs = new FreestyleFs({ vm });
    const result = await fs.readFileBytes("/image.png");

    expect(result).toEqual(binaryContent);
  });

  it("resolves relative paths with workingDir", async () => {
    const vm = createMockVm();
    const fs = new FreestyleFs({ vm, workingDir: "/workspace" });

    await fs.readFile("relative/path.txt");
    expect(vm.fs.readTextFile).toHaveBeenCalledWith("/workspace/relative/path.txt");
  });

  it("allows absolute paths within working directory", async () => {
    const vm = createMockVm();
    const fs = new FreestyleFs({ vm, workingDir: "/workspace" });

    await fs.readFile("/workspace/subdir/file.txt");
    expect(vm.fs.readTextFile).toHaveBeenCalledWith("/workspace/subdir/file.txt");
  });

  it("rejects absolute paths outside working directory", async () => {
    const vm = createMockVm();
    const fs = new FreestyleFs({ vm, workingDir: "/workspace" });

    await expect(fs.readFile("/etc/shadow")).rejects.toThrow("outside working directory");
  });
});
