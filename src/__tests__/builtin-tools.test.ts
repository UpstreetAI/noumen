import { describe, it, expect, beforeEach } from "vitest";
import { MockFs, MockComputer } from "./helpers.js";
import { notebookEditTool } from "../tools/notebook.js";
import { askUserTool } from "../tools/ask-user.js";
import { createWebSearchTool, webSearchToolPlaceholder } from "../tools/web-search.js";
import { editFileTool } from "../tools/edit.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import type { ToolContext } from "../tools/types.js";
import { FileStateCache } from "../file-state/cache.js";

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

// ---------------------------------------------------------------------------
// EditFile: CRLF normalization
// ---------------------------------------------------------------------------
describe("EditFile CRLF normalization", () => {
  it("matches and replaces text in CRLF files", async () => {
    fs.files.set("/project/crlf.txt", "line one\r\nline two\r\nline three\r\n");
    const cache = new FileStateCache();
    cache.set("/project/crlf.txt", {
      content: "line one\r\nline two\r\nline three\r\n",
      timestamp: 0,
    });

    const editCtx = { ...ctx, fileStateCache: cache };
    const result = await editFileTool.call(
      { file_path: "/project/crlf.txt", old_string: "line two", new_string: "line TWO" },
      editCtx,
    );

    expect(result.isError).toBeFalsy();
    const updated = fs.files.get("/project/crlf.txt")!;
    expect(updated).toContain("\r\n");
    expect(updated).toContain("line TWO\r\n");
    expect(updated).not.toContain("line two");
  });

  it("preserves LF endings in LF-only files", async () => {
    fs.files.set("/project/lf.txt", "line one\nline two\nline three\n");
    const cache = new FileStateCache();
    cache.set("/project/lf.txt", {
      content: "line one\nline two\nline three\n",
      timestamp: 0,
    });

    const editCtx = { ...ctx, fileStateCache: cache };
    const result = await editFileTool.call(
      { file_path: "/project/lf.txt", old_string: "line two", new_string: "line TWO" },
      editCtx,
    );

    expect(result.isError).toBeFalsy();
    const updated = fs.files.get("/project/lf.txt")!;
    expect(updated).not.toContain("\r\n");
    expect(updated).toContain("line TWO\n");
  });
});

// ---------------------------------------------------------------------------
// ReadFile: 256KB size limit
// ---------------------------------------------------------------------------
describe("ReadFile size limit", () => {
  it("rejects files larger than 256KB", async () => {
    const bigContent = "x".repeat(300 * 1024);
    fs.files.set("/project/big.txt", bigContent);
    fs.stats.set("/project/big.txt", { size: 300 * 1024, modifiedAt: new Date() });

    const result = await readFileTool.call({ file_path: "/project/big.txt" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too large");
    expect(result.content).toContain("256KB");
  });

  it("allows files under 256KB", async () => {
    const smallContent = "hello world\n";
    fs.files.set("/project/small.txt", smallContent);
    fs.stats.set("/project/small.txt", { size: smallContent.length, modifiedAt: new Date() });

    const result = await readFileTool.call({ file_path: "/project/small.txt" }, ctx);
    expect(result.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// WriteFile: content comparison fallback on mtime mismatch
// ---------------------------------------------------------------------------
describe("WriteFile content comparison on mtime mismatch", () => {
  it("allows write when mtime changed but content is identical", async () => {
    fs.files.set("/project/touched.txt", "original content");
    fs.stats.set("/project/touched.txt", { size: 16, modifiedAt: new Date(Date.now() + 5000) });

    const cache = new FileStateCache();
    cache.set("/project/touched.txt", {
      content: "original content",
      timestamp: Date.now() - 10000,
    });

    const writeCtx = { ...ctx, fileStateCache: cache };
    const result = await writeFileTool.call(
      { file_path: "/project/touched.txt", content: "new content" },
      writeCtx,
    );

    expect(result.isError).toBeFalsy();
    expect(fs.files.get("/project/touched.txt")).toBe("new content");
  });

  it("rejects write when mtime changed AND content differs", async () => {
    fs.files.set("/project/changed.txt", "externally modified");
    fs.stats.set("/project/changed.txt", { size: 19, modifiedAt: new Date(Date.now() + 5000) });

    const cache = new FileStateCache();
    cache.set("/project/changed.txt", {
      content: "original content",
      timestamp: Date.now() - 10000,
    });

    const writeCtx = { ...ctx, fileStateCache: cache };
    const result = await writeFileTool.call(
      { file_path: "/project/changed.txt", content: "overwrite" },
      writeCtx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("modified since last read");
  });
});

describe("ReadFile — large file with limit", () => {
  it("allows reading a large file when limit is specified", async () => {
    const bigContent = "line\n".repeat(100_000);
    fs.files.set("/project/big.txt", bigContent);
    fs.stats.set("/project/big.txt", { size: 20 * 1024 * 1024 });

    const result = await readFileTool.call(
      { file_path: "/project/big.txt", offset: 1, limit: 10 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it("blocks reading a large file without limit", async () => {
    fs.files.set("/project/big.txt", "content");
    fs.stats.set("/project/big.txt", { size: 20 * 1024 * 1024 });

    const result = await readFileTool.call(
      { file_path: "/project/big.txt" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too large");
  });
});

describe("EditFile — checkpoint tracking on empty file", () => {
  it("calls trackEdit when writing to an empty existing file", async () => {
    fs.files.set("/project/empty.txt", "");
    const trackEditCalls: string[] = [];
    const checkpointManager = {
      trackEdit: async (path: string) => { trackEditCalls.push(path); },
    };
    const editCtx = {
      ...ctx,
      checkpointManager,
      currentMessageId: "msg-1",
      sessionId: "sess-1",
    } as any;

    const result = await editFileTool.call(
      { file_path: "/project/empty.txt", old_string: "", new_string: "new content" },
      editCtx,
    );
    expect(result.isError).toBeFalsy();
    expect(trackEditCalls).toContain("/project/empty.txt");
  });
});
