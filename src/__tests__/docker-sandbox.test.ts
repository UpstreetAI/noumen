import { describe, it, expect, vi } from "vitest";
import { DockerComputer, type DockerContainer } from "../virtual/docker-computer.js";
import { DockerFs } from "../virtual/docker-fs.js";

function createMockContainer(
  handler: (cmd: string[], opts: Record<string, unknown>) => {
    exitCode: number;
    stdout: string;
    stderr: string;
  },
): DockerContainer {
  return {
    async exec(options: Record<string, unknown>) {
      const cmd = options.Cmd as string[];
      const result = handler(cmd, options);

      const stdoutBuf = Buffer.from(result.stdout, "utf-8");
      const stderrBuf = Buffer.from(result.stderr, "utf-8");

      const chunks: Buffer[] = [];

      if (stdoutBuf.length > 0) {
        const header = Buffer.alloc(8);
        header[0] = 1; // stdout
        header.writeUInt32BE(stdoutBuf.length, 4);
        chunks.push(Buffer.concat([header, stdoutBuf]));
      }
      if (stderrBuf.length > 0) {
        const header = Buffer.alloc(8);
        header[0] = 2; // stderr
        header.writeUInt32BE(stderrBuf.length, 4);
        chunks.push(Buffer.concat([header, stderrBuf]));
      }

      const { Readable } = await import("node:stream");
      const stream = new Readable({
        read() {
          for (const chunk of chunks) this.push(chunk);
          this.push(null);
        },
      });

      return {
        async start() {
          return stream;
        },
        async inspect() {
          return { ExitCode: result.exitCode };
        },
      };
    },
  };
}

describe("DockerComputer", () => {
  it("executes commands in the container", async () => {
    const container = createMockContainer((cmd) => {
      const fullCmd = (cmd as string[]).join(" ");
      if (fullCmd.includes("echo hello")) {
        return { exitCode: 0, stdout: "hello\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown" };
    });

    const computer = new DockerComputer({ container, defaultCwd: "/app" });
    const result = await computer.executeCommand("echo hello");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("passes environment variables", async () => {
    let capturedOpts: Record<string, unknown> = {};
    const container = createMockContainer((_cmd, opts) => {
      capturedOpts = opts;
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const computer = new DockerComputer({ container });
    await computer.executeCommand("env", { env: { FOO: "bar" } });

    expect(capturedOpts.Env).toEqual(["FOO=bar"]);
  });
});

describe("DockerFs", () => {
  it("reads files via cat", async () => {
    const container = createMockContainer((cmd) => {
      if (cmd[0] === "cat" && cmd[1] === "/app/test.txt") {
        return { exitCode: 0, stdout: "file content", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const fs = new DockerFs({ container, workingDir: "/app" });
    const content = await fs.readFile("test.txt");
    expect(content).toBe("file content");
  });

  it("checks existence via test -e", async () => {
    const container = createMockContainer((cmd) => {
      if (cmd[0] === "test" && cmd[2] === "/exists.txt") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    });

    const fs = new DockerFs({ container });
    expect(await fs.exists("/exists.txt")).toBe(true);
    expect(await fs.exists("/nope.txt")).toBe(false);
  });

  it("deletes files with rm", async () => {
    const deletedPaths: string[] = [];
    const container = createMockContainer((cmd) => {
      if (cmd[0] === "rm") {
        deletedPaths.push(cmd[cmd.length - 1]);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const fs = new DockerFs({ container });
    await fs.deleteFile("/tmp/old.txt");
    expect(deletedPaths).toContain("/tmp/old.txt");
  });

  it("allows absolute paths within working directory", async () => {
    const container = createMockContainer((cmd) => {
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });

    const fs = new DockerFs({ container, workingDir: "/app" });
    const content = await fs.readFile("/app/sub/test.txt");
    expect(content).toBe("ok");
  });

  it("rejects absolute paths outside working directory", async () => {
    const container = createMockContainer(() => {
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const fs = new DockerFs({ container, workingDir: "/app" });
    await expect(fs.readFile("/etc/shadow")).rejects.toThrow("outside working directory");
  });

  it("rejects relative path traversal", async () => {
    const container = createMockContainer(() => {
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const fs = new DockerFs({ container, workingDir: "/app" });
    await expect(fs.readFile("../../etc/passwd")).rejects.toThrow("escapes working directory");
  });

  it("creates directories with mkdir", async () => {
    const createdDirs: string[][] = [];
    const container = createMockContainer((cmd) => {
      if (cmd[0] === "mkdir") {
        createdDirs.push(cmd.slice(1));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const fs = new DockerFs({ container });
    await fs.mkdir("/app/new", { recursive: true });
    expect(createdDirs[0]).toContain("-p");
    expect(createdDirs[0]).toContain("/app/new");
  });
});
