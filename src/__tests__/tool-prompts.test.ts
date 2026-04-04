import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../tools/registry.js";
import { bashTool } from "../tools/bash.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";
import { webFetchTool } from "../tools/web-fetch.js";
import { notebookEditTool } from "../tools/notebook.js";
import { agentTool } from "../tools/agent.js";
import { createWebSearchTool } from "../tools/web-search.js";

describe("tool prompts", () => {
  const builtInTools = [
    bashTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    globTool,
    grepTool,
    webFetchTool,
    notebookEditTool,
    agentTool,
  ];

  it("all built-in tools have a prompt field", () => {
    for (const tool of builtInTools) {
      expect(tool.prompt, `${tool.name} should have a prompt`).toBeDefined();
    }
  });

  it("prompts are longer than descriptions", () => {
    for (const tool of builtInTools) {
      const prompt = typeof tool.prompt === "function" ? tool.prompt() : tool.prompt;
      expect(
        (prompt as string).length,
        `${tool.name} prompt should be longer than its description`,
      ).toBeGreaterThan(tool.description.length);
    }
  });

  it("createWebSearchTool produces a tool with a prompt function", () => {
    const tool = createWebSearchTool({
      search: async () => [],
    });
    expect(tool.prompt).toBeDefined();
    expect(typeof tool.prompt).toBe("function");
    const prompt = (tool.prompt as () => string)();
    expect(prompt.length).toBeGreaterThan(tool.description.length);
    expect(prompt).toContain("Sources:");
  });

  it("registry uses prompt field in tool definitions", () => {
    const registry = new ToolRegistry([]);
    const defs = registry.toToolDefinitions();

    const bashDef = defs.find((d) => d.function.name === "Bash");
    expect(bashDef).toBeDefined();
    expect(bashDef!.function.description).toContain("IMPORTANT: Avoid using this tool");
    expect(bashDef!.function.description.length).toBeGreaterThan(200);

    const readDef = defs.find((d) => d.function.name === "ReadFile");
    expect(readDef).toBeDefined();
    expect(readDef!.function.description).toContain("file_path parameter must be an absolute path");
  });

  it("description field remains short for UI/permission use", () => {
    for (const tool of builtInTools) {
      expect(
        tool.description.length,
        `${tool.name} description should be concise`,
      ).toBeLessThan(300);
    }
  });

  it("bash prompt steers away from cat/head/grep commands", () => {
    const prompt = typeof bashTool.prompt === "function" ? bashTool.prompt() : bashTool.prompt;
    expect(prompt).toContain("NOT cat/head/tail");
    expect(prompt).toContain("NOT grep or rg");
    expect(prompt).toContain("NOT sed/awk");
  });

  it("edit prompt requires reading first", () => {
    const prompt = typeof editFileTool.prompt === "function" ? editFileTool.prompt() : editFileTool.prompt;
    expect(prompt).toContain("ReadFile tool at least once before editing");
  });

  it("write prompt warns about overwriting", () => {
    const prompt = typeof writeFileTool.prompt === "function" ? writeFileTool.prompt() : writeFileTool.prompt;
    expect(prompt).toContain("overwrite the existing file");
    expect(prompt).toContain("NEVER create documentation files");
  });

  it("grep prompt disallows grep/rg in bash", () => {
    const prompt = typeof grepTool.prompt === "function" ? grepTool.prompt() : grepTool.prompt;
    expect(prompt).toContain("NEVER invoke `grep` or `rg` as a Bash command");
  });
});
