import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SshComputer, type SshClient, type SshSftpSession } from "../virtual/ssh-computer.js";
import { SshFs } from "../virtual/ssh-fs.js";
import { SshSandbox } from "../virtual/ssh-sandbox.js";

interface MockFsTree {
  [path: string]: string | { dir: true };
}

function createMockChannel(
  result: { exitCode: number; stdout: string; stderr: string },
) {
  const channel = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    destroy: () => void;
  };
  channel.stderr = new EventEmitter();
  channel.destroy = vi.fn(() => {
    channel.emit("close", 1);
  });

  process.nextTick(() => {
    if (result.stdout) {
      channel.emit("data", Buffer.from(result.stdout));
    }
    if (result.stderr) {
      channel.stderr.emit("data", Buffer.from(result.stderr));
    }
    channel.emit("close", result.exitCode);
  });

  return channel;
}

function createMockSshClient(
  execHandler: (command: string) => {
    exitCode: number;
    stdout: string;
    stderr: string;
  },
  fsTree: MockFsTree = {},
): SshClient {
  const tree = fsTree;

  const sftp: SshSftpSession = {
    readFile(path: string, ...args: any[]) {
      const cb = args[args.length - 1] as Function;
      const opts = args.length > 1 ? args[0] : undefined;
      if (tree[path] === undefined || typeof tree[path] === "object") {
        cb(new Error(`ENOENT: no such file: ${path}`));
        return;
      }
      if (opts?.encoding === "utf8") {
        cb(undefined, tree[path] as string);
      } else {
        cb(undefined, Buffer.from(tree[path] as string, "utf-8"));
      }
    },
    writeFile(path: string, data: string | Buffer, cb: Function) {
      tree[path] = typeof data === "string" ? data : data.toString("utf-8");
      cb(undefined);
    },
    appendFile(path: string, data: string | Buffer, cb: Function) {
      const existing = typeof tree[path] === "string" ? tree[path] : "";
      tree[path] = existing + (typeof data === "string" ? data : data.toString("utf-8"));
      cb(undefined);
    },
    unlink(path: string, cb: Function) {
      if (tree[path] === undefined) {
        cb(new Error(`ENOENT: no such file: ${path}`));
        return;
      }
      delete tree[path];
      cb(undefined);
    },
    rmdir(path: string, cb: Function) {
      delete tree[path];
      cb(undefined);
    },
    mkdir(path: string, cb: Function) {
      tree[path] = { dir: true };
      cb(undefined);
    },
    readdir(path: string, cb: Function) {
      const prefix = path.endsWith("/") ? path : path + "/";
      const entries: Array<{
        filename: string;
        longname: string;
        attrs: { size: number; isDirectory(): boolean; isFile(): boolean; mtime: number; atime: number };
      }> = [];
      for (const [key, value] of Object.entries(tree)) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          const name = key.slice(prefix.length);
          if (!name) continue;
          const isDir = typeof value === "object";
          entries.push({
            filename: name,
            longname: name,
            attrs: {
              size: isDir ? 0 : (value as string).length,
              isDirectory: () => isDir,
              isFile: () => !isDir,
              mtime: 1700000000,
              atime: 1700000000,
            },
          });
        }
      }
      cb(undefined, entries);
    },
    stat(path: string, cb: Function) {
      if (tree[path] === undefined) {
        cb(new Error(`ENOENT: no such file: ${path}`));
        return;
      }
      const value = tree[path];
      const isDir = typeof value === "object";
      cb(undefined, {
        size: isDir ? 0 : (value as string).length,
        isDirectory: () => isDir,
        isFile: () => !isDir,
        mtime: 1700000000,
        atime: 1700000000,
      });
    },
    open(path: string, _flags: string, cb: Function) {
      if (tree[path] === undefined || typeof tree[path] === "object") {
        cb(new Error(`ENOENT: no such file: ${path}`));
        return;
      }
      cb(undefined, Buffer.from(path));
    },
    read(handle: Buffer, buffer: Buffer, offset: number, length: number, _position: number, cb: Function) {
      const filePath = handle.toString();
      const content = tree[filePath] as string;
      const data = Buffer.from(content, "utf-8");
      const bytesToRead = Math.min(length, data.length);
      data.copy(buffer, offset, 0, bytesToRead);
      cb(undefined, bytesToRead, buffer);
    },
    close(_handle: Buffer, cb: Function) {
      cb(undefined);
    },
    end: vi.fn(),
  };

  return {
    exec(command: string, ...args: any[]) {
      const cb = args[args.length - 1] as Function;
      const result = execHandler(command);
      const channel = createMockChannel(result);
      cb(undefined, channel);
    },
    sftp(cb: Function) {
      cb(undefined, sftp);
    },
    end: vi.fn(),
    on() {
      return this;
    },
  } as unknown as SshClient;
}

// ---------------------------------------------------------------------------
// SshComputer
// ---------------------------------------------------------------------------

describe("SshComputer", () => {
  it("executes commands over SSH", async () => {
    const client = createMockSshClient((cmd) => {
      if (cmd.includes("echo hello")) {
        return { exitCode: 0, stdout: "hello\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown" };
    });

    const computer = new SshComputer({ client, defaultCwd: "/app" });
    const result = await computer.executeCommand("echo hello");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("uses the configured default cwd", async () => {
    let capturedCommand = "";
    const client = createMockSshClient((cmd) => {
      capturedCommand = cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const computer = new SshComputer({ client, defaultCwd: "/workspace" });
    await computer.executeCommand("ls");

    expect(capturedCommand).toContain("cd '/workspace'");
  });

  it("passes environment variables as shell prefix", async () => {
    let capturedCommand = "";
    const client = createMockSshClient((cmd) => {
      capturedCommand = cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const computer = new SshComputer({ client });
    await computer.executeCommand("env", { env: { FOO: "bar" } });

    expect(capturedCommand).toContain("FOO='bar'");
  });

  it("returns non-zero exit codes", async () => {
    const client = createMockSshClient(() => {
      return { exitCode: 42, stdout: "", stderr: "failed" };
    });

    const computer = new SshComputer({ client });
    const result = await computer.executeCommand("false");

    expect(result.exitCode).toBe(42);
    expect(result.stderr).toBe("failed");
  });

  it("rejects on exec error", async () => {
    const client = {
      exec(command: string, ...args: any[]) {
        const cb = args[args.length - 1] as Function;
        cb(new Error("connection lost"));
      },
      sftp: vi.fn(),
      end: vi.fn(),
      on() { return this; },
    } as unknown as SshClient;

    const computer = new SshComputer({ client });
    await expect(computer.executeCommand("ls")).rejects.toThrow("connection lost");
  });
});

// ---------------------------------------------------------------------------
// SshFs
// ---------------------------------------------------------------------------

describe("SshFs", () => {
  it("reads files via SFTP", async () => {
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      { "/workspace/test.txt": "hello world" },
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    const content = await fs.readFile("test.txt");
    expect(content).toBe("hello world");
  });

  it("writes files via SFTP", async () => {
    const tree: MockFsTree = {};
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      tree,
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    await fs.writeFile("new.txt", "content");
    expect(tree["/workspace/new.txt"]).toBe("content");
  });

  it("appends to files via SFTP", async () => {
    const tree: MockFsTree = { "/workspace/log.txt": "line1\n" };
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      tree,
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    await fs.appendFile("log.txt", "line2\n");
    expect(tree["/workspace/log.txt"]).toBe("line1\nline2\n");
  });

  it("checks file existence", async () => {
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      { "/workspace/exists.txt": "yes" },
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    expect(await fs.exists("exists.txt")).toBe(true);
    expect(await fs.exists("nope.txt")).toBe(false);
  });

  it("deletes files", async () => {
    const tree: MockFsTree = { "/workspace/old.txt": "data" };
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      tree,
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    await fs.deleteFile("old.txt");
    expect(tree["/workspace/old.txt"]).toBeUndefined();
  });

  it("creates directories", async () => {
    const tree: MockFsTree = {};
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      tree,
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    await fs.mkdir("subdir");
    expect(tree["/workspace/subdir"]).toEqual({ dir: true });
  });

  it("lists directory contents", async () => {
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      {
        "/workspace/a.txt": "aaa",
        "/workspace/b.txt": "bbb",
        "/workspace/sub": { dir: true },
      },
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    const entries = await fs.readdir("/workspace");
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "b.txt", "sub"]);
    expect(entries.find((e) => e.name === "sub")!.isDirectory).toBe(true);
    expect(entries.find((e) => e.name === "a.txt")!.isFile).toBe(true);
  });

  it("returns file stats", async () => {
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      { "/workspace/file.txt": "12345" },
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    const stat = await fs.stat("file.txt");
    expect(stat.size).toBe(5);
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
  });

  it("reads file bytes with maxBytes cap", async () => {
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      { "/workspace/big.txt": "abcdefghij" },
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    const buf = await fs.readFileBytes!("big.txt", 3);
    expect(buf.length).toBe(3);
    expect(buf.toString("utf-8")).toBe("abc");
  });

  it("rejects absolute paths outside working directory", async () => {
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    await expect(fs.readFile("/etc/shadow")).rejects.toThrow("outside working directory");
  });

  it("rejects relative path traversal", async () => {
    const client = createMockSshClient(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
    );

    const fs = new SshFs({ client, workingDir: "/workspace" });
    await expect(fs.readFile("../../etc/passwd")).rejects.toThrow("escapes working directory");
  });
});

// ---------------------------------------------------------------------------
// SshSandbox factory
// ---------------------------------------------------------------------------

describe("SshSandbox", () => {
  it("wraps an explicit client into fs + computer", async () => {
    const client = createMockSshClient(
      (cmd) => {
        if (cmd.includes("echo hi")) {
          return { exitCode: 0, stdout: "hi\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "" };
      },
      { "/home/test.txt": "data" },
    );

    const sandbox = SshSandbox({ client, cwd: "/home" });
    const result = await sandbox.computer.executeCommand("echo hi");
    expect(result.stdout).toBe("hi\n");

    const content = await sandbox.fs.readFile("test.txt");
    expect(content).toBe("data");
  });

  it("throws when neither client nor host is provided", () => {
    expect(() => SshSandbox({} as any)).toThrow(
      "SshSandbox requires either `client` or `host`",
    );
  });

  it("returns sandboxId from host:port", () => {
    const client = createMockSshClient(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    const sandbox = SshSandbox({
      client,
      host: "myhost.example.com",
      port: 2222,
    });
    expect(sandbox.sandboxId!()).toBe("myhost.example.com:2222");
  });

  it("returns host:22 as default sandboxId", () => {
    const client = createMockSshClient(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    const sandbox = SshSandbox({ client, host: "myhost.example.com" });
    expect(sandbox.sandboxId!()).toBe("myhost.example.com:22");
  });

  it("dispose is a no-op for explicit client", async () => {
    const client = createMockSshClient(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    const sandbox = SshSandbox({ client });
    // explicit client has no dispose
    expect(sandbox.dispose).toBeUndefined();
    expect(client.end).not.toHaveBeenCalled();
  });
});
