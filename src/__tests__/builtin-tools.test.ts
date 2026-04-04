import { describe, it, expect, beforeEach } from "vitest";
import { MockFs, MockComputer } from "./helpers.js";
import { notebookEditTool } from "../tools/notebook.js";
import { askUserTool } from "../tools/ask-user.js";
import { createWebSearchTool, webSearchToolPlaceholder } from "../tools/web-search.js";
import type { ToolContext } from "../tools/types.js";

let fs: MockFs;
let computer: MockComputer;
let ctx: ToolContext;

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  ctx = { fs, computer, cwd: "/project" };
});

// ---------------------------------------------------------------------------
// NotebookEdit
// ---------------------------------------------------------------------------
describe("NotebookEdit", () => {
  const sampleNotebook = JSON.stringify({
    cells: [
      { cell_type: "code", source: ["print('hello')\n"], metadata: {}, outputs: [], execution_count: 1 },
      { cell_type: "markdown", source: ["# Title\n"], metadata: {} },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });

  beforeEach(() => {
    fs.files.set("/project/test.ipynb", sampleNotebook);
  });

  it("replaces cell source", async () => {
    const result = await notebookEditTool.call(
      { notebook_path: "/project/test.ipynb", cell_index: 0, new_source: "print('world')" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Replaced cell 0");

    const updated = JSON.parse(fs.files.get("/project/test.ipynb")!);
    expect(updated.cells[0].source).toEqual(["print('world')"]);
  });

  it("inserts a new cell", async () => {
    const result = await notebookEditTool.call(
      {
        notebook_path: "/project/test.ipynb",
        cell_index: 1,
        new_source: "x = 42",
        cell_type: "code",
        edit_mode: "insert",
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Inserted new code cell");

    const updated = JSON.parse(fs.files.get("/project/test.ipynb")!);
    expect(updated.cells).toHaveLength(3);
    expect(updated.cells[1].source).toEqual(["x = 42"]);
  });

  it("deletes a cell", async () => {
    const result = await notebookEditTool.call(
      { notebook_path: "/project/test.ipynb", cell_index: 1, edit_mode: "delete" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Deleted cell 1");

    const updated = JSON.parse(fs.files.get("/project/test.ipynb")!);
    expect(updated.cells).toHaveLength(1);
  });

  it("rejects out-of-range cell index for replace", async () => {
    const result = await notebookEditTool.call(
      { notebook_path: "/project/test.ipynb", cell_index: 5, new_source: "x" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("out of range");
  });

  it("handles invalid JSON gracefully", async () => {
    fs.files.set("/project/bad.ipynb", "not json");
    const result = await notebookEditTool.call(
      { notebook_path: "/project/bad.ipynb", cell_index: 0, new_source: "x" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Not a valid JSON");
  });

  it("rejects unknown edit_mode", async () => {
    const result = await notebookEditTool.call(
      { notebook_path: "/project/test.ipynb", cell_index: 0, new_source: "x", edit_mode: "patch" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown edit_mode");
  });
});

// ---------------------------------------------------------------------------
// AskUser
// ---------------------------------------------------------------------------
describe("AskUser", () => {
  it("returns error when no handler is configured", async () => {
    const result = await askUserTool.call({ question: "What color?" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no userInputHandler");
  });

  it("returns user answer when handler is configured", async () => {
    const ctxWithHandler: ToolContext = {
      ...ctx,
      userInputHandler: async (q) => `The answer to "${q}" is blue.`,
    };
    const result = await askUserTool.call({ question: "What color?" }, ctxWithHandler);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("blue");
  });

  it("handles handler errors", async () => {
    const ctxWithHandler: ToolContext = {
      ...ctx,
      userInputHandler: async () => { throw new Error("timeout"); },
    };
    const result = await askUserTool.call({ question: "x?" }, ctxWithHandler);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timeout");
  });
});

// ---------------------------------------------------------------------------
// WebSearch
// ---------------------------------------------------------------------------
describe("createWebSearchTool", () => {
  it("formats search results", async () => {
    const searchTool = createWebSearchTool({
      search: async (query) => [
        { title: "Docs", url: "https://example.com", snippet: "Example docs" },
        { title: "Guide", url: "https://guide.com", snippet: "Guide content" },
      ],
    });

    const result = await searchTool.call({ query: "test" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Docs");
    expect(result.content).toContain("https://example.com");
    expect(result.content).toContain("Guide");
  });

  it("handles empty results", async () => {
    const searchTool = createWebSearchTool({
      search: async () => [],
    });

    const result = await searchTool.call({ query: "nothing" }, ctx);
    expect(result.content).toContain("No search results");
  });

  it("passes domains to search function", async () => {
    let receivedDomains: string[] | undefined;
    const searchTool = createWebSearchTool({
      search: async (_query, domains) => {
        receivedDomains = domains;
        return [];
      },
    });

    await searchTool.call({ query: "test", domains: "a.com, b.com" }, ctx);
    expect(receivedDomains).toEqual(["a.com", "b.com"]);
  });

  it("handles search errors", async () => {
    const searchTool = createWebSearchTool({
      search: async () => { throw new Error("API limit"); },
    });

    const result = await searchTool.call({ query: "test" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("API limit");
  });
});

describe("webSearchToolPlaceholder", () => {
  it("returns configuration error", async () => {
    const result = await webSearchToolPlaceholder.call({ query: "test" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not configured");
  });
});
