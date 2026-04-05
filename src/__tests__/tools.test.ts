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
