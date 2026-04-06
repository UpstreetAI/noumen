import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeToolsStep, type SpillFn } from "../pipeline/execute-tools-step.js";
import type { ToolCallContent, StreamEvent, ChatMessage } from "../session/types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import type { ToolExecutionContext } from "../tools/execution-pipeline.js";
import type { StreamingExecResult } from "../tools/streaming-executor.js";
import { StreamingToolExecutor } from "../tools/streaming-executor.js";
import { ToolRegistry } from "../tools/registry.js";
import { SessionStorage } from "../session/storage.js";
import { NoopTracer } from "../tracing/noop.js";
import { MockFs, MockComputer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Mock resolvePermission — avoids node:fs path resolution
// ---------------------------------------------------------------------------

vi.mock("../permissions/pipeline.js", () => ({
  resolvePermission: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTc(name: string, id: string = "tc_1"): ToolCallContent {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

function makeTool(overrides?: Partial<Tool>): Tool {
  return {
    name: "TestTool",
    description: "A test tool",
    parameters: { type: "object", properties: {}, required: [] },
    call: async () => ({ content: "ok" }),
    ...overrides,
  };
}

function makeToolCtx(): ToolContext {
  return { fs: new MockFs(), computer: new MockComputer(), cwd: "/test" };
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  const reg = new ToolRegistry([]);
  for (const t of tools) reg.register(t);
  return reg;
}

function makeExecCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    registry: makeRegistry([makeTool()]),
    toolCtx: makeToolCtx(),
    permCtx: null,
    permHandler: null,
    denialTracker: null,
    hooks: [],
    sessionId: "test-session",
    tracer: new NoopTracer(),
    buildPermissionOpts: () => undefined,
    ...overrides,
  };
}

function noopSpill(): SpillFn {
  return async (_id, _name, content) => ({ content, spilled: false });
}

function makeStorage(): SessionStorage {
  return new SessionStorage(new MockFs(), "/sessions");
}

// ---------------------------------------------------------------------------
// Streaming path tests
// ---------------------------------------------------------------------------

describe("executeToolsStep", () => {
  describe("streaming path", () => {
    it("collects results from streaming executor and emits tool_result events", async () => {
      const tool = makeTool({ name: "ReadFile" });
      const registry = makeRegistry([tool]);
      const tc = makeTc("ReadFile", "tc_stream_1");

      const executor = new StreamingToolExecutor(
        (name) => registry.get(name),
        async () => ({
          result: { content: "file contents" },
          events: [],
        }),
      );
      executor.addTool(tc, { file_path: "/a.txt" });
      // Allow the tool to execute
      await new Promise((r) => setTimeout(r, 20));
      executor.discard();

      const messages: ChatMessage[] = [];
      const recentlyRead = new Map<string, string>();
      const storage = makeStorage();

      const result = await executeToolsStep(
        [tc],
        executor,
        [],
        makeExecCtx({ registry }),
        registry,
        "s1",
        messages,
        recentlyRead,
        storage,
        noopSpill(),
      );

      const toolResultEvents = result.events.filter((e) => e.type === "tool_result");
      expect(toolResultEvents).toHaveLength(1);
      expect((toolResultEvents[0] as { toolName: string }).toolName).toBe("ReadFile");

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("tool");
      expect(messages[0].tool_call_id).toBe("tc_stream_1");
    });

    it("includes pre-collected streaming results", async () => {
      const tc = makeTc("Bash", "tc_pre");
      const preResult: StreamingExecResult = {
        toolCall: tc,
        parsedArgs: {},
        result: { content: "pre-collected" },
        events: [],
      };

      const executor = new StreamingToolExecutor(
        () => undefined,
        async () => ({ result: { content: "" }, events: [] }),
      );
      executor.discard();

      const messages: ChatMessage[] = [];
      const result = await executeToolsStep(
        [tc],
        executor,
        [preResult],
        makeExecCtx(),
        makeRegistry([]),
        "s2",
        messages,
        new Map(),
        makeStorage(),
        noopSpill(),
      );

      expect(result.events.filter((e) => e.type === "tool_result")).toHaveLength(1);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("pre-collected");
    });
  });

  // ---------------------------------------------------------------------------
  // Batched path tests
  // ---------------------------------------------------------------------------

  describe("batched path", () => {
    it("executes tools and emits tool_result events", async () => {
      const tool = makeTool({
        name: "WriteFile",
        call: async () => ({ content: "written" }),
      });
      const registry = makeRegistry([tool]);
      const tc = makeTc("WriteFile", "tc_batch_1");

      const messages: ChatMessage[] = [];
      const result = await executeToolsStep(
        [tc],
        null,
        [],
        makeExecCtx({ registry }),
        registry,
        "s3",
        messages,
        new Map(),
        makeStorage(),
        noopSpill(),
      );

      const toolResultEvents = result.events.filter((e) => e.type === "tool_result");
      expect(toolResultEvents).toHaveLength(1);
      expect((toolResultEvents[0] as { toolName: string }).toolName).toBe("WriteFile");

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("tool");
      expect(messages[0].content).toBe("written");
    });

    it("handles multiple tool calls in batch", async () => {
      const tool1 = makeTool({ name: "ReadFile", call: async () => ({ content: "r1" }) });
      const tool2 = makeTool({ name: "Bash", call: async () => ({ content: "b1" }) });
      const registry = makeRegistry([tool1, tool2]);

      const messages: ChatMessage[] = [];
      const result = await executeToolsStep(
        [makeTc("ReadFile", "tc_r"), makeTc("Bash", "tc_b")],
        null,
        [],
        makeExecCtx({ registry }),
        registry,
        "s4",
        messages,
        new Map(),
        makeStorage(),
        noopSpill(),
      );

      expect(result.events.filter((e) => e.type === "tool_result")).toHaveLength(2);
      expect(messages).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // preventContinuation propagation
  // ---------------------------------------------------------------------------

  describe("preventContinuation", () => {
    it("propagates from streaming results", async () => {
      const tc = makeTc("TestTool", "tc_pc");
      const preResult: StreamingExecResult = {
        toolCall: tc,
        parsedArgs: {},
        result: { content: "ok" },
        preventContinuation: true,
        events: [],
      };

      const executor = new StreamingToolExecutor(
        () => undefined,
        async () => ({ result: { content: "" }, events: [] }),
      );
      executor.discard();

      const result = await executeToolsStep(
        [tc],
        executor,
        [preResult],
        makeExecCtx(),
        makeRegistry([]),
        "s5",
        [],
        new Map(),
        makeStorage(),
        noopSpill(),
      );

      expect(result.preventContinuation).toBe(true);
    });

    it("defaults to false when no result sets it", async () => {
      const tool = makeTool({ call: async () => ({ content: "ok" }) });
      const registry = makeRegistry([tool]);

      const result = await executeToolsStep(
        [makeTc("TestTool")],
        null,
        [],
        makeExecCtx({ registry }),
        registry,
        "s6",
        [],
        new Map(),
        makeStorage(),
        noopSpill(),
      );

      expect(result.preventContinuation).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Spill integration
  // ---------------------------------------------------------------------------

  describe("spill", () => {
    it("collects spill records when spillFn returns spilled=true", async () => {
      const tool = makeTool({
        name: "ReadFile",
        call: async () => ({ content: "x".repeat(200_000) }),
      });
      const registry = makeRegistry([tool]);

      const spillFn: SpillFn = async (id, _name, _content) => ({
        content: `[spilled:${id}]`,
        spilled: true,
      });

      const messages: ChatMessage[] = [];
      const result = await executeToolsStep(
        [makeTc("ReadFile", "tc_spill")],
        null,
        [],
        makeExecCtx({ registry }),
        registry,
        "s7",
        messages,
        new Map(),
        makeStorage(),
        spillFn,
      );

      expect(result.spilledRecords).toHaveLength(1);
      expect(result.spilledRecords[0].toolUseId).toBe("tc_spill");
      expect(result.spilledRecords[0].replacement).toBe("[spilled:tc_spill]");
      expect(messages[0].content).toBe("[spilled:tc_spill]");
    });

    it("does not produce spill records when spillFn returns spilled=false", async () => {
      const tool = makeTool({ call: async () => ({ content: "small" }) });
      const registry = makeRegistry([tool]);

      const result = await executeToolsStep(
        [makeTc("TestTool")],
        null,
        [],
        makeExecCtx({ registry }),
        registry,
        "s8",
        [],
        new Map(),
        makeStorage(),
        noopSpill(),
      );

      expect(result.spilledRecords).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Permission denied
  // ---------------------------------------------------------------------------

  describe("permission denied", () => {
    it("does not emit tool_result events for denied results", async () => {
      const tc = makeTc("TestTool", "tc_denied");
      const deniedResult: StreamingExecResult = {
        toolCall: tc,
        parsedArgs: {},
        result: { content: "Permission denied" },
        permissionDenied: true,
        events: [{ type: "permission_denied", toolName: "TestTool", toolUseId: "tc_denied" } as StreamEvent],
      };

      const executor = new StreamingToolExecutor(
        () => undefined,
        async () => ({ result: { content: "" }, events: [] }),
      );
      executor.discard();

      const messages: ChatMessage[] = [];
      const result = await executeToolsStep(
        [tc],
        executor,
        [deniedResult],
        makeExecCtx(),
        makeRegistry([]),
        "s9",
        messages,
        new Map(),
        makeStorage(),
        noopSpill(),
      );

      const toolResultEvents = result.events.filter((e) => e.type === "tool_result");
      expect(toolResultEvents).toHaveLength(0);

      const permDeniedEvents = result.events.filter((e) => e.type === "permission_denied");
      expect(permDeniedEvents).toHaveLength(1);

      // Tool result message is still pushed for conversation structure
      expect(messages).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // File tracking
  // ---------------------------------------------------------------------------

  describe("file tracking", () => {
    it("tracks touched file paths for file tools", async () => {
      const tool = makeTool({
        name: "WriteFile",
        call: async () => ({ content: "done" }),
      });
      const registry = makeRegistry([tool]);
      const tc: ToolCallContent = {
        id: "tc_file",
        type: "function",
        function: { name: "WriteFile", arguments: JSON.stringify({ file_path: "/foo.ts" }) },
      };

      const result = await executeToolsStep(
        [tc],
        null,
        [],
        makeExecCtx({ registry }),
        registry,
        "s10",
        [],
        new Map(),
        makeStorage(),
        noopSpill(),
      );

      expect(result.touchedFilePaths).toContain("/foo.ts");
    });

    it("populates recentlyReadFiles for ReadFile tool", async () => {
      const tool = makeTool({
        name: "ReadFile",
        call: async () => ({ content: "file-data" }),
      });
      const registry = makeRegistry([tool]);
      const tc: ToolCallContent = {
        id: "tc_read",
        type: "function",
        function: { name: "ReadFile", arguments: JSON.stringify({ file_path: "/bar.ts" }) },
      };

      const recentlyRead = new Map<string, string>();
      await executeToolsStep(
        [tc],
        null,
        [],
        makeExecCtx({ registry }),
        registry,
        "s11",
        [],
        recentlyRead,
        makeStorage(),
        noopSpill(),
      );

      expect(recentlyRead.get("/bar.ts")).toBe("file-data");
    });

    it("does not track paths for non-file tools", async () => {
      const tool = makeTool({
        name: "Bash",
        call: async () => ({ content: "output" }),
      });
      const registry = makeRegistry([tool]);
      const tc: ToolCallContent = {
        id: "tc_bash",
        type: "function",
        function: { name: "Bash", arguments: JSON.stringify({ command: "ls" }) },
      };

      const result = await executeToolsStep(
        [tc],
        null,
        [],
        makeExecCtx({ registry }),
        registry,
        "s12",
        [],
        new Map(),
        makeStorage(),
        noopSpill(),
      );

      expect(result.touchedFilePaths).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Git operation events
  // ---------------------------------------------------------------------------

  describe("git operations", () => {
    it("emits git_operation events from tool result metadata", async () => {
      const tool = makeTool({
        name: "Bash",
        call: async () => ({
          content: "committed",
          metadata: {
            gitOperations: [{ type: "commit", details: "abc123" }],
          },
        }),
      });
      const registry = makeRegistry([tool]);

      const result = await executeToolsStep(
        [makeTc("Bash", "tc_git")],
        null,
        [],
        makeExecCtx({ registry }),
        registry,
        "s13",
        [],
        new Map(),
        makeStorage(),
        noopSpill(),
      );

      const gitEvents = result.events.filter((e) => e.type === "git_operation");
      expect(gitEvents).toHaveLength(1);
      expect((gitEvents[0] as { operation: string }).operation).toBe("commit");
    });
  });
});
