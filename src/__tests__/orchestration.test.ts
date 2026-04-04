import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  multiToolCallResponse,
} from "./helpers.js";
import { Thread, type ThreadConfig } from "../thread.js";
import type { StreamEvent } from "../session/types.js";
import type { ToolCallContent } from "../session/types.js";
import { partitionToolCalls, runToolsBatched } from "../tools/orchestration.js";
import { all } from "../utils/generators.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import type { Tool, ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// all() generator utility
// ---------------------------------------------------------------------------
describe("all()", () => {
  it("yields values from multiple generators concurrently", async () => {
    async function* gen(id: string, count: number) {
      for (let i = 0; i < count; i++) {
        yield `${id}-${i}`;
      }
    }
    const results: string[] = [];
    for await (const v of all([gen("a", 2), gen("b", 3)])) {
      results.push(v);
    }
    expect(results).toHaveLength(5);
    expect(results).toContain("a-0");
    expect(results).toContain("b-2");
  });

  it("respects concurrency cap", async () => {
    let maxConcurrent = 0;
    let current = 0;

    async function* tracked(id: string) {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      yield id;
      current--;
    }

    const gens = Array.from({ length: 5 }, (_, i) => tracked(`g${i}`));
    const results: string[] = [];
    for await (const v of all(gens, 2)) {
      results.push(v);
    }
    expect(results).toHaveLength(5);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("handles empty generator list", async () => {
    const results: string[] = [];
    for await (const v of all<string>([])) {
      results.push(v);
    }
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// partitionToolCalls
// ---------------------------------------------------------------------------
describe("partitionToolCalls", () => {
  const safeTool: Tool = {
    name: "SafeTool",
    description: "safe",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: true,
    call: async () => ({ content: "ok" }),
  };

  const unsafeTool: Tool = {
    name: "UnsafeTool",
    description: "unsafe",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: false,
    call: async () => ({ content: "ok" }),
  };

  const tools = new Map<string, Tool>([
    ["SafeTool", safeTool],
    ["UnsafeTool", unsafeTool],
  ]);

  function makeTc(name: string, id: string): ToolCallContent {
    return { id, type: "function", function: { name, arguments: "{}" } };
  }

  it("groups consecutive safe tools into one batch", () => {
    const tcs = [makeTc("SafeTool", "1"), makeTc("SafeTool", "2"), makeTc("SafeTool", "3")];
    const batches = partitionToolCalls(tcs, (n) => tools.get(n));
    expect(batches).toHaveLength(1);
    expect(batches[0].isConcurrencySafe).toBe(true);
    expect(batches[0].items).toHaveLength(3);
  });

  it("isolates unsafe tools into their own batches", () => {
    const tcs = [makeTc("SafeTool", "1"), makeTc("UnsafeTool", "2"), makeTc("SafeTool", "3")];
    const batches = partitionToolCalls(tcs, (n) => tools.get(n));
    expect(batches).toHaveLength(3);
    expect(batches[0].isConcurrencySafe).toBe(true);
    expect(batches[1].isConcurrencySafe).toBe(false);
    expect(batches[2].isConcurrencySafe).toBe(true);
  });

  it("treats unknown tools as not concurrency-safe", () => {
    const tcs = [makeTc("Unknown", "1")];
    const batches = partitionToolCalls(tcs, () => undefined);
    expect(batches).toHaveLength(1);
    expect(batches[0].isConcurrencySafe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runToolsBatched
// ---------------------------------------------------------------------------
describe("runToolsBatched", () => {
  const safeTool: Tool = {
    name: "SafeTool",
    description: "safe",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: true,
    call: async () => ({ content: "ok" }),
  };

  function makeTc(name: string, id: string): ToolCallContent {
    return { id, type: "function", function: { name, arguments: "{}" } };
  }

  it("executes tool calls and yields results", async () => {
    const tcs = [makeTc("SafeTool", "1"), makeTc("SafeTool", "2")];
    const results = [];
    for await (const r of runToolsBatched(
      tcs,
      () => safeTool,
      async (tc, args) => ({
        toolCall: tc,
        parsedArgs: args,
        result: { content: `result-${tc.id}` },
      }),
    )) {
      results.push(r);
    }
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.result.content).sort()).toEqual(["result-1", "result-2"]);
  });
});

// ---------------------------------------------------------------------------
// Thread integration: parallel read-only tools
// ---------------------------------------------------------------------------
describe("Thread parallel tool execution", () => {
  let fs: MockFs;
  let computer: MockComputer;
  let provider: MockAIProvider;
  let config: ThreadConfig;

  beforeEach(() => {
    fs = new MockFs({
      "/project/a.txt": "content-a",
      "/project/b.txt": "content-b",
    });
    computer = new MockComputer();
    provider = new MockAIProvider();
    config = {
      provider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };
  });

  async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const e of gen) events.push(e);
    return events;
  }

  it("executes multiple read-only tools in a single model turn", async () => {
    provider.addResponse(
      multiToolCallResponse([
        { id: "tc1", name: "ReadFile", args: { file_path: "/project/a.txt" } },
        { id: "tc2", name: "ReadFile", args: { file_path: "/project/b.txt" } },
      ]),
    );
    provider.addResponse(textResponse("Done reading both files."));

    const thread = new Thread(config, { sessionId: "s1" });
    const events = await collectEvents(thread.run("read both files"));

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);

    if (toolResults[0].type === "tool_result" && toolResults[1].type === "tool_result") {
      const contents = [String(toolResults[0].result.content), String(toolResults[1].result.content)];
      expect(contents.some((c) => c.includes("content-a"))).toBe(true);
      expect(contents.some((c) => c.includes("content-b"))).toBe(true);
    }

    const complete = events.find((e) => e.type === "message_complete");
    expect(complete).toBeDefined();
  });

  it("handles mixed safe and unsafe tool calls correctly", async () => {
    fs.files.set("/project/x.txt", "original");
    computer.handler = () => ({ exitCode: 0, stdout: "bash output", stderr: "" });

    provider.addResponse(
      multiToolCallResponse([
        { id: "tc1", name: "ReadFile", args: { file_path: "/project/x.txt" } },
        { id: "tc2", name: "Bash", args: { command: "echo hi" } },
        { id: "tc3", name: "ReadFile", args: { file_path: "/project/x.txt" } },
      ]),
    );
    provider.addResponse(textResponse("All done."));

    const thread = new Thread(config, { sessionId: "s1" });
    const events = await collectEvents(thread.run("do stuff"));

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(3);
  });
});
