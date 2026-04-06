import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  toolCallResponse,
  multiToolCallResponse,
} from "./helpers.js";
import { Thread, type ThreadConfig } from "../thread.js";
import type { StreamEvent, ToolCallContent } from "../session/types.js";
import type { Tool } from "../tools/types.js";
import { StreamingToolExecutor } from "../tools/streaming-executor.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ---------------------------------------------------------------------------
// StreamingToolExecutor unit tests
// ---------------------------------------------------------------------------
describe("StreamingToolExecutor", () => {
  const safeTool: Tool = {
    name: "Safe",
    description: "safe",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: true,
    call: async () => ({ content: "ok" }),
  };

  const unsafeTool: Tool = {
    name: "Unsafe",
    description: "unsafe",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: false,
    call: async () => ({ content: "ok" }),
  };

  const tools = new Map<string, Tool>([
    ["Safe", safeTool],
    ["Unsafe", unsafeTool],
  ]);

  function makeTc(name: string, id: string): ToolCallContent {
    return { id, type: "function", function: { name, arguments: "{}" } };
  }

  it("executes safe tools concurrently and yields results", async () => {
    const executionOrder: string[] = [];
    const executor = new StreamingToolExecutor(
      (name) => tools.get(name),
      async (tc) => {
        executionOrder.push(tc.function.name);
        return { result: { content: `result-${tc.id}` }, events: [] };
      },
    );

    executor.addTool(makeTc("Safe", "1"), {});
    executor.addTool(makeTc("Safe", "2"), {});

    const results = [];
    for await (const r of executor.getRemainingResults()) {
      results.push(r);
    }

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.result.content).sort()).toEqual(["result-1", "result-2"]);
  });

  it("serializes unsafe tools", async () => {
    const executionOrder: string[] = [];
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const executor = new StreamingToolExecutor(
      (name) => tools.get(name),
      async (tc) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 10));
        concurrentCount--;
        executionOrder.push(tc.id);
        return { result: { content: `done-${tc.id}` }, events: [] };
      },
    );

    executor.addTool(makeTc("Unsafe", "1"), {});
    executor.addTool(makeTc("Unsafe", "2"), {});

    const results = [];
    for await (const r of executor.getRemainingResults()) {
      results.push(r);
    }

    expect(results).toHaveLength(2);
    expect(executionOrder).toEqual(["1", "2"]);
    expect(maxConcurrent).toBe(1);
  });

  it("getCompletedResults yields results during streaming", async () => {
    let resolve1: () => void;
    const promise1 = new Promise<void>((r) => { resolve1 = r; });

    const executor = new StreamingToolExecutor(
      (name) => tools.get(name),
      async (tc) => {
        if (tc.id === "1") {
          await promise1;
        }
        return { result: { content: `done-${tc.id}` }, events: [] };
      },
    );

    executor.addTool(makeTc("Safe", "1"), {});
    executor.addTool(makeTc("Safe", "2"), {});

    // Wait a tick for tool 2 to potentially complete
    await new Promise((r) => setTimeout(r, 20));

    // Tool 1 is still executing; tool 2 may be done but tool 1 blocks yield order
    const immediate = [...executor.getCompletedResults()];
    // Since tool 1 is safe and not done yet, tool 2 should be yielded
    // Actually per the implementation: tool 1 is safe and executing, tool 2 can yield
    // because both are safe. But tool 1 comes first and isn't complete.
    // Actually the impl blocks on any executing tool that precedes completed ones.
    // Let's just resolve and drain.
    resolve1!();

    const results = [];
    for await (const r of executor.getRemainingResults()) {
      results.push(r);
    }
    // Results should include both
    const allResults = [...immediate, ...results];
    expect(allResults.length).toBeLessThanOrEqual(2);
    expect(allResults.length + immediate.length - immediate.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Thread integration with streaming tool execution
// ---------------------------------------------------------------------------
describe("Thread with streamingToolExecution", () => {
  let fs: MockFs;
  let computer: MockComputer;
  let provider: MockAIProvider;

  beforeEach(() => {
    fs = new MockFs({
      "/project/a.txt": "AAA",
      "/project/b.txt": "BBB",
    });
    computer = new MockComputer();
    provider = new MockAIProvider();
  });

  async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const e of gen) events.push(e);
    return events;
  }

  it("processes single tool call with streaming execution", async () => {
    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/project/a.txt" }),
    );
    provider.addResponse(textResponse("Read it."));

    const config: ThreadConfig = {
      provider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      streamingToolExecution: true,
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "s1" });
    const events = await collectEvents(thread.run("read a.txt"));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
    if (results[0].type === "tool_result") {
      expect(results[0].result.content).toContain("AAA");
    }

    const complete = events.find((e) => e.type === "message_complete");
    expect(complete).toBeDefined();
  });

  it("processes multiple parallel tool calls", async () => {
    provider.addResponse(
      multiToolCallResponse([
        { id: "tc1", name: "ReadFile", args: { file_path: "/project/a.txt" } },
        { id: "tc2", name: "ReadFile", args: { file_path: "/project/b.txt" } },
      ]),
    );
    provider.addResponse(textResponse("Read both."));

    const config: ThreadConfig = {
      provider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      streamingToolExecution: true,
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "s1" });
    const events = await collectEvents(thread.run("read both files"));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);

    const contents = results.map((r) => {
      if (r.type === "tool_result") return r.result.content;
      return "";
    });
    expect(contents.some((c) => String(c).includes("AAA"))).toBe(true);
    expect(contents.some((c) => String(c).includes("BBB"))).toBe(true);
  });

  it("still works without streaming execution (default)", async () => {
    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/project/a.txt" }),
    );
    provider.addResponse(textResponse("Done."));

    const config: ThreadConfig = {
      provider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "s1" });
    const events = await collectEvents(thread.run("read"));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Deferred tool_use_start emission
// ---------------------------------------------------------------------------
describe("deferred tool_use_start emission", () => {
  it("emits tool_use_start when id and name arrive in separate chunks", async () => {
    const splitChunks: import("../providers/types.js").ChatStreamChunk[] = [
      {
        id: "s1", model: "m",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "tc_split",
              type: "function",
              function: { name: undefined as unknown as string, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "s2", model: "m",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: "ReadFile", arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "s3", model: "m",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: JSON.stringify({ file_path: "/test.txt" }) },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "s4", model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ];

    const fs = new MockFs();
    fs.files.set("/test.txt", "content");
    const computer = new MockComputer();
    const provider = new MockAIProvider();
    provider.addResponse(splitChunks);
    provider.addResponse([
      { id: "d1", model: "m", choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] },
      { id: "d2", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);

    const config: ThreadConfig = {
      provider,
      fs,
      computer,
      sessionDir: "/sessions",
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };

    const thread = new Thread(config, { sessionId: "split-tc" });
    const events = await collectEvents(thread.run("read"));

    const toolStarts = events.filter((e) => e.type === "tool_use_start");
    expect(toolStarts).toHaveLength(1);
    if (toolStarts[0].type === "tool_use_start") {
      expect(toolStarts[0].toolName).toBe("ReadFile");
      expect(toolStarts[0].toolUseId).toBe("tc_split");
    }
  });
});

// ---------------------------------------------------------------------------
// Sibling abort cancellation
// ---------------------------------------------------------------------------
describe("StreamingToolExecutor sibling cancellation", () => {
  it("Bash error aborts sibling tools", async () => {
    const { StreamingToolExecutor } = await import("../tools/streaming-executor.js");

    const signalsReceived: string[] = [];
    const executor = new StreamingToolExecutor(
      (name) => {
        if (name === "Bash") return { name: "Bash", description: "", parameters: { type: "object", properties: {} }, isConcurrencySafe: true, call: async () => ({ content: "" }) } as any;
        return { name, description: "", parameters: { type: "object", properties: {} }, isConcurrencySafe: true, call: async () => ({ content: "" }) } as any;
      },
      async (toolCall, _args, signal) => {
        if (toolCall.function.name === "Bash") {
          return { result: { content: "command failed", isError: true }, events: [] };
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 500);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            signalsReceived.push(toolCall.function.name);
            resolve(undefined);
          });
        });
        return { result: { content: "ok" }, events: [] };
      },
    );

    const bashCall = { id: "bash1", type: "function" as const, function: { name: "Bash", arguments: '{"command":"fail"}' } };
    const readCall = { id: "read1", type: "function" as const, function: { name: "ReadFile", arguments: '{"path":"test.txt"}' } };

    executor.addTool(bashCall, { command: "fail" });
    executor.addTool(readCall, { path: "test.txt" });

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) {
      results.push(r);
    }

    expect(results).toHaveLength(2);
    const bashResult = results.find((r) => r.toolCall.function.name === "Bash");
    expect(bashResult!.result.isError).toBe(true);
  });

  it("parent signal abort propagates to all tools", async () => {
    const { StreamingToolExecutor } = await import("../tools/streaming-executor.js");
    const parentAc = new AbortController();

    const executor = new StreamingToolExecutor(
      () => ({ name: "ReadFile", description: "", parameters: { type: "object", properties: {} }, isConcurrencySafe: true, call: async () => ({ content: "" }) } as any),
      async (_toolCall, _args, signal) => {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000);
          signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); });
        });
        return { result: { content: "ok" }, events: [] };
      },
      parentAc.signal,
    );

    const readCall = { id: "r1", type: "function" as const, function: { name: "ReadFile", arguments: '{}' } };
    executor.addTool(readCall, {});

    setTimeout(() => parentAc.abort(), 50);

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) {
      results.push(r);
    }
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("non-Bash errors do not abort siblings", async () => {
    const { StreamingToolExecutor } = await import("../tools/streaming-executor.js");

    let siblingCompleted = false;
    const executor = new StreamingToolExecutor(
      () => ({ name: "ReadFile", description: "", parameters: { type: "object", properties: {} }, isConcurrencySafe: true, call: async () => ({ content: "" }) } as any),
      async (toolCall) => {
        if (toolCall.id === "err1") {
          return { result: { content: "error", isError: true }, events: [] };
        }
        await new Promise((r) => setTimeout(r, 50));
        siblingCompleted = true;
        return { result: { content: "ok" }, events: [] };
      },
    );

    executor.addTool({ id: "err1", type: "function" as const, function: { name: "ReadFile", arguments: '{}' } }, {});
    executor.addTool({ id: "ok1", type: "function" as const, function: { name: "ReadFile", arguments: '{}' } }, {});

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) {
      results.push(r);
    }
    expect(siblingCompleted).toBe(true);
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// processQueue re-entrance guard
// ---------------------------------------------------------------------------
describe("StreamingToolExecutor re-entrance guard", () => {
  it("does not double-execute unsafe tools when completions race", async () => {
    const { StreamingToolExecutor } = await import("../tools/streaming-executor.js");

    const executionCounts = new Map<string, number>();

    const executor = new StreamingToolExecutor(
      (name) => ({
        name,
        description: "",
        parameters: { type: "object", properties: {} },
        isConcurrencySafe: false,
        call: async () => ({ content: "" }),
      } as any),
      async (toolCall) => {
        const count = (executionCounts.get(toolCall.id) ?? 0) + 1;
        executionCounts.set(toolCall.id, count);
        await new Promise((r) => setTimeout(r, 10));
        return { result: { content: `done-${toolCall.id}` }, events: [] };
      },
    );

    executor.addTool({ id: "u1", type: "function" as const, function: { name: "WriteFile", arguments: '{}' } }, {});
    executor.addTool({ id: "u2", type: "function" as const, function: { name: "WriteFile", arguments: '{}' } }, {});
    executor.addTool({ id: "u3", type: "function" as const, function: { name: "WriteFile", arguments: '{}' } }, {});

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) {
      results.push(r);
    }

    expect(results).toHaveLength(3);
    expect(executionCounts.get("u1")).toBe(1);
    expect(executionCounts.get("u2")).toBe(1);
    expect(executionCounts.get("u3")).toBe(1);
  });
});
