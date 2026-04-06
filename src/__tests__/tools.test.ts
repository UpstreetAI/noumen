import { describe, it, expect, beforeEach } from "vitest";
import { MockFs, MockComputer } from "./helpers.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { bashTool } from "../tools/bash.js";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

let fs: MockFs;
let computer: MockComputer;
let ctx: ToolContext;

beforeEach(() => {
  fs = new MockFs({
    "/project/hello.ts": "line1\nline2\nline3\nline4\nline5",
    "/project/empty.ts": "",
  });
  computer = new MockComputer();
  ctx = { fs, computer, cwd: "/project" };
});

// -----------------------------------------------------------------------
// ReadFile
// -----------------------------------------------------------------------
describe("ReadFile", () => {
  it("reads a file with line numbers", async () => {
    const result = await readFileTool.call({ file_path: "/project/hello.ts" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("     1|line1");
    expect(result.content).toContain("     5|line5");
  });

  it("supports offset and limit", async () => {
    const result = await readFileTool.call(
      { file_path: "/project/hello.ts", offset: 2, limit: 2 },
      ctx,
    );
    expect(result.content).toContain("     2|line2");
    expect(result.content).toContain("     3|line3");
    expect(result.content).not.toContain("line1");
    expect(result.content).toContain("... 2 lines not shown ...");
  });

  it("returns error for missing file", async () => {
    const result = await readFileTool.call({ file_path: "/nope" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error reading file");
  });

  it("handles empty file", async () => {
    const result = await readFileTool.call({ file_path: "/project/empty.ts" }, ctx);
    // An empty string splits into [""], producing one empty-content line
    expect(result.content).toContain("1|");
  });
});

// -----------------------------------------------------------------------
// WriteFile
// -----------------------------------------------------------------------
describe("WriteFile", () => {
  it("creates a new file", async () => {
    const result = await writeFileTool.call(
      { file_path: "/project/new.ts", content: "hello" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("created");
    expect(fs.files.get("/project/new.ts")).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    const result = await writeFileTool.call(
      { file_path: "/project/hello.ts", content: "replaced" },
      ctx,
    );
    expect(result.content).toContain("updated");
    expect(fs.files.get("/project/hello.ts")).toBe("replaced");
  });
});

// -----------------------------------------------------------------------
// EditFile
// -----------------------------------------------------------------------
describe("EditFile", () => {
  it("replaces a unique match", async () => {
    const result = await editFileTool.call(
      { file_path: "/project/hello.ts", old_string: "line2", new_string: "LINE2" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("updated successfully");
    expect(fs.files.get("/project/hello.ts")).toContain("LINE2");
    expect(fs.files.get("/project/hello.ts")).not.toContain("line2");
  });

  it("errors when string not found", async () => {
    const result = await editFileTool.call(
      { file_path: "/project/hello.ts", old_string: "nope", new_string: "x" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("errors when multiple matches without replace_all", async () => {
    fs.files.set("/project/dup.ts", "aaa bbb aaa");
    const result = await editFileTool.call(
      { file_path: "/project/dup.ts", old_string: "aaa", new_string: "x" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("2 times");
  });

  it("replaces all when replace_all is true", async () => {
    fs.files.set("/project/dup.ts", "aaa bbb aaa");
    const result = await editFileTool.call(
      {
        file_path: "/project/dup.ts",
        old_string: "aaa",
        new_string: "x",
        replace_all: true,
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(fs.files.get("/project/dup.ts")).toBe("x bbb x");
  });
});

// -----------------------------------------------------------------------
// Bash
// -----------------------------------------------------------------------
describe("Bash", () => {
  it("returns stdout for successful command", async () => {
    computer.handler = () => ({ exitCode: 0, stdout: "ok\n", stderr: "" });
    const result = await bashTool.call({ command: "echo ok" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("ok");
  });

  it("marks error for non-zero exit code", async () => {
    computer.handler = () => ({ exitCode: 1, stdout: "", stderr: "fail" });
    const result = await bashTool.call({ command: "false" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Exit code: 1");
    expect(result.content).toContain("fail");
  });

  it("truncates long output", async () => {
    const long = "x".repeat(200_000);
    computer.handler = () => ({ exitCode: 0, stdout: long, stderr: "" });
    const result = await bashTool.call({ command: "big" }, ctx);
    expect(result.content.length).toBeLessThan(long.length);
    expect(result.content).toContain("truncated");
  });

  it("shows (no output) for empty stdout/stderr", async () => {
    computer.handler = () => ({ exitCode: 0, stdout: "", stderr: "" });
    const result = await bashTool.call({ command: "true" }, ctx);
    expect(result.content).toBe("(no output)");
  });
});

// -----------------------------------------------------------------------
// Glob
// -----------------------------------------------------------------------
describe("Glob", () => {
  it("returns file list from rg output", async () => {
    computer.handler = () => ({
      exitCode: 0,
      stdout: "src/a.ts\nsrc/b.ts\n",
      stderr: "",
    });
    const result = await globTool.call({ pattern: "*.ts" }, ctx);
    expect(result.content).toContain("src/a.ts");
    expect(result.content).toContain("src/b.ts");
  });

  it("returns no-match message for empty output", async () => {
    computer.handler = () => ({ exitCode: 0, stdout: "", stderr: "" });
    const result = await globTool.call({ pattern: "*.xyz" }, ctx);
    expect(result.content).toContain("No files found");
  });

  it("truncates at MAX_RESULTS", async () => {
    const lines = Array.from({ length: 210 }, (_, i) => `file${i}.ts`).join("\n");
    computer.handler = () => ({ exitCode: 0, stdout: lines, stderr: "" });
    const result = await globTool.call({ pattern: "*.ts" }, ctx);
    expect(result.content).toContain("truncated");
  });
});

// -----------------------------------------------------------------------
// Grep
// -----------------------------------------------------------------------
describe("Grep", () => {
  it("returns matching lines", async () => {
    computer.handler = () => ({
      exitCode: 0,
      stdout: "src/a.ts:10:const x = 1;\n",
      stderr: "",
    });
    const result = await grepTool.call({ pattern: "const x" }, ctx);
    expect(result.content).toContain("const x");
  });

  it("returns no-match message for exit code 1 with empty output", async () => {
    computer.handler = () => ({ exitCode: 1, stdout: "", stderr: "" });
    const result = await grepTool.call({ pattern: "nope" }, ctx);
    expect(result.content).toContain("No matches found");
  });

  it("returns error for exit code > 1", async () => {
    computer.handler = () => ({ exitCode: 2, stdout: "", stderr: "bad regex" });
    const result = await grepTool.call({ pattern: "[invalid" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("bad regex");
  });
});

// -----------------------------------------------------------------------
// ToolRegistry
// -----------------------------------------------------------------------
describe("ToolRegistry", () => {
  it("registers all 9 built-in tools", () => {
    const registry = new ToolRegistry();
    expect(registry.listTools()).toHaveLength(9);
  });

  it("gets a tool by name", () => {
    const registry = new ToolRegistry();
    expect(registry.get("ReadFile")).toBeDefined();
    expect(registry.get("NonExistent")).toBeUndefined();
  });

  it("execute returns error for unknown tool", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute("FakeTool", {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });

  it("toToolDefinitions returns correct shape", () => {
    const registry = new ToolRegistry();
    const defs = registry.toToolDefinitions();
    expect(defs.length).toBe(9);
    for (const def of defs) {
      expect(def.type).toBe("function");
      expect(def.function.name).toBeTruthy();
      expect(def.function.description).toBeTruthy();
      expect(def.function.parameters.type).toBe("object");
    }
  });

  it("accepts additional tools", () => {
    const custom = {
      name: "Custom",
      description: "test",
      parameters: { type: "object" as const, properties: {} },
      call: async () => ({ content: "ok" }),
    };
    const registry = new ToolRegistry([custom]);
    expect(registry.listTools()).toHaveLength(10);
    expect(registry.get("Custom")).toBeDefined();
  });

  it("returns error result when tool.call throws", async () => {
    const throwingTool = {
      name: "Throwy",
      description: "throws",
      parameters: { type: "object" as const, properties: {} },
      call: async () => { throw new Error("tool exploded"); },
    };
    const registry = new ToolRegistry([throwingTool]);
    const result = await registry.execute("Throwy", {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("tool exploded");
  });
});

// ---------------------------------------------------------------------------
// Glob tool fallback to find when rg is unavailable
// ---------------------------------------------------------------------------
describe("glob tool fallback to find when rg unavailable", () => {
  it("falls back to find when rg returns exit code 127", async () => {
    const mockComputer = new MockComputer((cmd) => {
      if (cmd.startsWith("rg ")) {
        return { exitCode: 127, stdout: "", stderr: "rg: command not found" };
      }
      if (cmd.startsWith("find ")) {
        return { exitCode: 0, stdout: "src/index.ts\nsrc/main.ts\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const findCtx = { fs, computer: mockComputer, cwd: "/project" } as any;
    const result = await globTool.call({ pattern: "*.ts" }, findCtx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("src/index.ts");
    expect(result.content).toContain("src/main.ts");
  });

  it("falls back to find when stderr says not found", async () => {
    const mockComputer = new MockComputer((cmd) => {
      if (cmd.startsWith("rg ")) {
        return { exitCode: 1, stdout: "", stderr: "sh: rg: not found" };
      }
      if (cmd.startsWith("find ")) {
        return { exitCode: 0, stdout: "README.md\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const findCtx = { fs, computer: mockComputer, cwd: "/project" } as any;
    const result = await globTool.call({ pattern: "*.md" }, findCtx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("README.md");
  });

  it("does not fall back when rg succeeds", async () => {
    let findCalled = false;
    const mockComputer = new MockComputer((cmd) => {
      if (cmd.startsWith("rg ")) {
        return { exitCode: 0, stdout: "lib/util.ts\n", stderr: "" };
      }
      if (cmd.startsWith("find ")) {
        findCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const findCtx = { fs, computer: mockComputer, cwd: "/project" } as any;
    const result = await globTool.call({ pattern: "*.ts" }, findCtx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("lib/util.ts");
    expect(findCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReadFile: limit should not load entire file into memory
// ---------------------------------------------------------------------------
describe("ReadFile with limit caps read size", () => {
  it("passes maxBytes option to fs.readFile when limit is set", async () => {
    let receivedOpts: any = undefined;
    const bigFs = new MockFs({ "/project/big.ts": "line1\nline2\nline3" });
    const origReadFile = bigFs.readFile.bind(bigFs);
    bigFs.readFile = async (path: string, opts?: any) => {
      receivedOpts = opts;
      return origReadFile(path, opts);
    };
    bigFs.stats.set("/project/big.ts", { size: 500 * 1024 * 1024 });

    const bigCtx = { fs: bigFs, computer, cwd: "/project" } as any;
    await readFileTool.call({ file_path: "/project/big.ts", offset: 1, limit: 10 }, bigCtx);
    expect(receivedOpts).toBeDefined();
    expect(receivedOpts.maxBytes).toBeDefined();
    expect(receivedOpts.maxBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
  });

  it("does not pass maxBytes when limit is not set", async () => {
    let receivedOpts: any = undefined;
    const smallFs = new MockFs({ "/project/small.ts": "line1\nline2" });
    const origReadFile = smallFs.readFile.bind(smallFs);
    smallFs.readFile = async (path: string, opts?: any) => {
      receivedOpts = opts;
      return origReadFile(path, opts);
    };

    const smallCtx = { fs: smallFs, computer, cwd: "/project" } as any;
    await readFileTool.call({ file_path: "/project/small.ts" }, smallCtx);
    expect(receivedOpts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Glob: absolute path patterns should not get **/ prepended
// ---------------------------------------------------------------------------
describe("Glob absolute path handling", () => {
  it("does not prepend **/ to absolute path patterns", async () => {
    let capturedCmd = "";
    const mockComputer = new MockComputer((cmd) => {
      capturedCmd = cmd;
      return { exitCode: 0, stdout: "/project/src/index.ts\n", stderr: "" };
    });

    const absCtx = { fs, computer: mockComputer, cwd: "/project" } as any;
    await globTool.call({ pattern: "/project/src/*.ts" }, absCtx);
    expect(capturedCmd).not.toContain("**//project");
    expect(capturedCmd).toContain("/project/src/*.ts");
  });

  it("still prepends **/ to relative patterns", async () => {
    let capturedCmd = "";
    const mockComputer = new MockComputer((cmd) => {
      capturedCmd = cmd;
      return { exitCode: 0, stdout: "src/index.ts\n", stderr: "" };
    });

    const relCtx = { fs, computer: mockComputer, cwd: "/project" } as any;
    await globTool.call({ pattern: "*.ts" }, relCtx);
    expect(capturedCmd).toContain("**/*.ts");
  });
});
