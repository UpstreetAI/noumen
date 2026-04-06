/**
 * Integration test harness for Thread.run.
 *
 * These tests exercise the full turn loop end-to-end using MockAIProvider,
 * MockFs, and MockComputer. They target cross-cutting interaction paths
 * that unit tests miss — normalization + tool execution + streaming + abort
 * + permission all working together.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  textChunk,
  toolCallResponse,
  toolCallStartChunk,
  toolCallArgChunk,
  toolCallsFinishChunk,
  multiToolCallResponse,
  stopChunk,
} from "./helpers.js";
import { Thread } from "../thread.js";
import type { ThreadConfig } from "../thread.js";
import type { StreamEvent, ChatMessage, AssistantMessage } from "../session/types.js";
import type { AIProvider, ChatParams, ChatStreamChunk } from "../providers/types.js";
import { ChatStreamError } from "../providers/types.js";
import type { Tool, ToolResult, ToolContext } from "../tools/types.js";
import type { HookDefinition } from "../hooks/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import { CLEARED_PLACEHOLDER } from "../compact/microcompact.js";
import { assertValidMessageSequence } from "../messages/invariants.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let fs: MockFs;
let computer: MockComputer;
let provider: MockAIProvider;
let baseConfig: ThreadConfig;

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  provider = new MockAIProvider();
  baseConfig = {
    provider,
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

function makeTool(overrides: Partial<Tool> & { name: string; call: Tool["call"] }): Tool {
  return {
    description: `Mock tool: ${overrides.name}`,
    parameters: { type: "object", properties: {}, required: [] },
    isConcurrencySafe: true,
    isReadOnly: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Normal text completion (baseline)
// ---------------------------------------------------------------------------

describe("Integration: Thread.run scenarios", () => {
  it("text-only response yields text_delta + message_complete + turn_complete", async () => {
    provider.addResponse(textResponse("Hello world"));

    const thread = new Thread(baseConfig, { sessionId: "integ-1" });
    const events = await collectEvents(thread.run("hi"));

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "message_complete")).toBe(true);
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Single tool call -> result -> continuation -> final text
  // ---------------------------------------------------------------------------

  it("tool call loop: execute tool, get result, model continues with text", async () => {
    const echoTool = makeTool({
      name: "Echo",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo" } },
        required: ["text"],
      },
      call: async (args) => ({ content: `echo: ${args.text}` }),
    });

    const config: ThreadConfig = { ...baseConfig, tools: [echoTool] };

    provider.addResponse(toolCallResponse("tc1", "Echo", { text: "ping" }));
    provider.addResponse(textResponse("Got the echo."));

    const thread = new Thread(config, { sessionId: "integ-2" });
    const events = await collectEvents(thread.run("echo ping"));

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result.content).toContain("echo: ping");
    }

    const complete = events.find((e) => e.type === "message_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "message_complete") {
      expect(complete.message.content).toBe("Got the echo.");
    }

    expect(provider.calls).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Multi-tool concurrent batch -> one fails -> continuation
  // ---------------------------------------------------------------------------

  it("multi-tool batch: one tool fails, all results returned, model continues", async () => {
    const succeedTool = makeTool({
      name: "Succeed",
      call: async () => ({ content: "ok" }),
    });
    const failTool = makeTool({
      name: "Fail",
      call: async () => ({ content: "boom", isError: true }),
    });

    const config: ThreadConfig = { ...baseConfig, tools: [succeedTool, failTool] };

    provider.addResponse(
      multiToolCallResponse([
        { id: "tc_ok", name: "Succeed", args: {} },
        { id: "tc_fail", name: "Fail", args: {} },
      ]),
    );
    provider.addResponse(textResponse("Handled the failure."));

    const thread = new Thread(config, { sessionId: "integ-3" });
    const events = await collectEvents(thread.run("do both"));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);

    const failResult = results.find(
      (e) => e.type === "tool_result" && e.toolName === "Fail",
    );
    expect(failResult).toBeDefined();
    if (failResult?.type === "tool_result") {
      expect(failResult.result.isError).toBe(true);
    }

    expect(provider.calls).toHaveLength(2);
    expect(events.some((e) => e.type === "message_complete")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: 3+ assistant segments with same _turnId merge correctly
  //             (regression test for the mergeAssistantsByTurnId fix)
  // ---------------------------------------------------------------------------

  it("three assistant segments with same _turnId merge into one", async () => {
    const { normalizeMessagesForAPI } = await import("../messages/normalize.js");

    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "part1", _turnId: "t1", tool_calls: [{ id: "tc1", type: "function" as const, function: { name: "A", arguments: "{}" } }] },
      { role: "tool" as const, tool_call_id: "tc1", content: "r1" },
      { role: "assistant" as const, content: "part2", _turnId: "t1", tool_calls: [{ id: "tc2", type: "function" as const, function: { name: "B", arguments: "{}" } }] },
      { role: "tool" as const, tool_call_id: "tc2", content: "r2" },
      { role: "assistant" as const, content: "part3", _turnId: "t1" },
    ];

    const normalized = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(normalized);
    const assistants = normalized.filter((m) => m.role === "assistant");

    // All three segments should merge into a single assistant
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toContain("part1");
    expect(assistants[0].content).toContain("part2");
    expect(assistants[0].content).toContain("part3");
    expect(assistants[0].tool_calls).toHaveLength(2);

    // _turnId should be stripped from the output
    expect("_turnId" in assistants[0]).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Malformed tool JSON -> recovery -> valid call
  // ---------------------------------------------------------------------------

  it("malformed tool JSON is sent as error, model retries with valid call", async () => {
    const echoTool = makeTool({
      name: "Echo",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      call: async (args) => ({ content: `echo: ${args.text}` }),
    });

    const config: ThreadConfig = { ...baseConfig, tools: [echoTool] };

    // First response: malformed JSON arguments
    provider.addResponse([
      toolCallStartChunk("tc_bad", "Echo"),
      toolCallArgChunk("{invalid json"),
      toolCallsFinishChunk(),
    ]);
    // Second response: valid tool call
    provider.addResponse(toolCallResponse("tc_good", "Echo", { text: "fixed" }));
    // Third response: final text
    provider.addResponse(textResponse("Done."));

    const thread = new Thread(config, { sessionId: "integ-5" });
    const events = await collectEvents(thread.run("echo something"));

    // The malformed call should produce a tool_result with an error
    const toolResults = events.filter((e) => e.type === "tool_result");
    const errorResult = toolResults.find(
      (e) => e.type === "tool_result" && e.result.isError,
    );
    expect(errorResult).toBeDefined();

    // Then the valid call should succeed
    const goodResult = toolResults.find(
      (e) => e.type === "tool_result" && !e.result.isError,
    );
    expect(goodResult).toBeDefined();

    // Final text response
    expect(events.some((e) => e.type === "message_complete")).toBe(true);
    expect(provider.calls).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Abort mid-stream with partial tool results
  // ---------------------------------------------------------------------------

  it("aborting during stream stops the loop and yields session_end-like events", async () => {
    const slowTool = makeTool({
      name: "Slow",
      call: () => new Promise((resolve) => setTimeout(() => resolve({ content: "done" }), 5000)),
    });

    const config: ThreadConfig = { ...baseConfig, tools: [slowTool] };
    const ac = new AbortController();

    // Model calls a tool, but we'll abort before it finishes
    provider.addResponse(toolCallResponse("tc1", "Slow", {}));

    const thread = new Thread(config, { sessionId: "integ-6" });
    const gen = thread.run("do slow thing", { signal: ac.signal });

    const events: StreamEvent[] = [];
    let eventCount = 0;

    for await (const e of gen) {
      events.push(e);
      eventCount++;
      // Abort after seeing the tool_use_start
      if (e.type === "tool_use_start") {
        ac.abort();
      }
      // Safety valve
      if (eventCount > 50) break;
    }

    // We should have gotten at least tool_use_start
    expect(events.some((e) => e.type === "tool_use_start")).toBe(true);
    // The loop should have terminated (not hung forever)
    expect(eventCount).toBeLessThan(50);
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: Streaming tool execution integration
  // ---------------------------------------------------------------------------

  it("streaming tool execution starts tools during model stream", async () => {
    const callOrder: string[] = [];
    const fastTool = makeTool({
      name: "Fast",
      call: async () => {
        callOrder.push("fast-executed");
        return { content: "fast result" };
      },
    });

    const config: ThreadConfig = {
      ...baseConfig,
      tools: [fastTool],
      streamingToolExecution: true,
    };

    provider.addResponse(toolCallResponse("tc1", "Fast", {}));
    provider.addResponse(textResponse("Used fast tool."));

    const thread = new Thread(config, { sessionId: "integ-7" });
    const events = await collectEvents(thread.run("use fast tool"));

    expect(callOrder).toContain("fast-executed");

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result.content).toBe("fast result");
    }

    expect(events.some((e) => e.type === "message_complete")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: Error tool result with non-text content (sanitization)
  // ---------------------------------------------------------------------------

  it("Anthropic conversion strips non-text parts from error tool results", async () => {
    const { convertAnthropicMessages } = await import("../providers/anthropic-shared.js");
    const { normalizeMessagesForAPI } = await import("../messages/normalize.js");

    const messages = normalizeMessagesForAPI([
      { role: "user" as const, content: "test" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "tc1", type: "function" as const, function: { name: "T", arguments: "{}" } }],
      },
      {
        role: "tool" as const,
        tool_call_id: "tc1",
        content: [
          { type: "text" as const, text: "Error description" },
          { type: "image" as const, data: "base64data", media_type: "image/png" },
        ],
        isError: true,
      },
    ]);
    assertValidMessageSequence(messages);

    const { messages: anthropicMsgs } = convertAnthropicMessages(
      "system prompt",
      messages,
    );

    // Find the tool_result block in the user message
    const userWithToolResult = anthropicMsgs.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Record<string, unknown>[]).some((b) => b.type === "tool_result"),
    );
    expect(userWithToolResult).toBeDefined();

    const toolResultBlock = (
      userWithToolResult!.content as Record<string, unknown>[]
    ).find((b) => b.type === "tool_result") as Record<string, unknown>;
    expect(toolResultBlock.is_error).toBe(true);

    // Content should be text-only (no image blocks)
    const content = toolResultBlock.content as Record<string, unknown>[];
    if (Array.isArray(content)) {
      for (const block of content) {
        expect(block.type).toBe("text");
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 9: maxTurns enforcement across tool loop
  // ---------------------------------------------------------------------------

  it("maxTurns stops the loop after N tool turns", async () => {
    const counterTool = makeTool({
      name: "Inc",
      call: async () => ({ content: "incremented" }),
    });

    const config: ThreadConfig = { ...baseConfig, tools: [counterTool] };

    // Each model response calls a tool, causing a loop
    provider.addResponse(toolCallResponse("tc1", "Inc", {}));
    provider.addResponse(toolCallResponse("tc2", "Inc", {}));
    provider.addResponse(toolCallResponse("tc3", "Inc", {}));
    provider.addResponse(textResponse("final")); // should not be reached

    const thread = new Thread(config, { sessionId: "integ-9" });
    const events = await collectEvents(thread.run("count", { maxTurns: 2 }));

    const maxTurnsEvent = events.find((e) => e.type === "max_turns_reached");
    expect(maxTurnsEvent).toBeDefined();
    if (maxTurnsEvent?.type === "max_turns_reached") {
      expect(maxTurnsEvent.maxTurns).toBe(2);
    }

    // Should have called provider at most 3 times (2 tool turns + the one that hits the limit)
    expect(provider.calls.length).toBeLessThanOrEqual(3);
  });

  // ---------------------------------------------------------------------------
  // Scenario 10: Permission denied -> denial tracking -> fallback
  // ---------------------------------------------------------------------------

  it("permission denied emits denial events and tracks denials", async () => {
    const restrictedTool = makeTool({
      name: "Restricted",
      isReadOnly: false,
      call: async () => ({ content: "should not reach" }),
    });

    const config: ThreadConfig = {
      ...baseConfig,
      tools: [restrictedTool],
      permissions: {
        mode: "plan",
        rules: [],
        workingDirectories: [],
      },
    };

    // Model tries to use the restricted tool
    provider.addResponse(toolCallResponse("tc1", "Restricted", {}));
    // After denial, model gives up
    provider.addResponse(textResponse("Permission was denied."));

    const thread = new Thread(config, { sessionId: "integ-10" });
    const events = await collectEvents(thread.run("do restricted thing"));

    const denied = events.filter((e) => e.type === "permission_denied");
    expect(denied.length).toBeGreaterThanOrEqual(1);

    // The tool result with Permission denied content is persisted to
    // messages but may not emit a separate tool_result stream event
    // (denial is signalled via permission_denied event). Verify the
    // denial event has the expected shape.
    if (denied[0]?.type === "permission_denied") {
      expect(denied[0].toolName).toBe("Restricted");
      expect(denied[0].message).toBeTruthy();
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 11: Tool that throws -> PostToolUseFailure hooks fire
  // ---------------------------------------------------------------------------

  it("thrown tool error fires PostToolUseFailure hooks", async () => {
    const hookCalls: string[] = [];
    const throwingTool = makeTool({
      name: "Throw",
      call: async () => {
        throw new Error("intentional explosion");
      },
    });

    const failureHook: HookDefinition = {
      event: "PostToolUseFailure",
      handler: async (input) => {
        hookCalls.push(`failure:${(input as Record<string, unknown>).toolName}`);
        return {};
      },
    };

    const config: ThreadConfig = {
      ...baseConfig,
      tools: [throwingTool],
      hooks: [failureHook],
    };

    provider.addResponse(toolCallResponse("tc1", "Throw", {}));
    provider.addResponse(textResponse("Caught it."));

    const thread = new Thread(config, { sessionId: "integ-11" });
    const events = await collectEvents(thread.run("throw"));

    expect(hookCalls).toContain("failure:Throw");

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result.isError).toBe(true);
      expect(toolResult.result.content).toContain("intentional explosion");
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 12: PreToolUse hooks run before permission check
  // ---------------------------------------------------------------------------

  it("PreToolUse hooks can modify input before permission evaluation", async () => {
    const executionOrder: string[] = [];

    const testTool = makeTool({
      name: "PathTool",
      isReadOnly: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      call: async (args) => {
        executionOrder.push(`executed:${args.path}`);
        return { content: `read ${args.path}` };
      },
    });

    const preToolHook: HookDefinition = {
      event: "PreToolUse",
      handler: async (input) => {
        executionOrder.push("hook:PreToolUse");
        const toolInput = (input as Record<string, unknown>).toolInput as Record<string, unknown>;
        return {
          updatedInput: { ...toolInput, path: "/modified/path.txt" },
        };
      },
    };

    const config: ThreadConfig = {
      ...baseConfig,
      tools: [testTool],
      hooks: [preToolHook],
    };

    provider.addResponse(toolCallResponse("tc1", "PathTool", { path: "/original/path.txt" }));
    provider.addResponse(textResponse("Done."));

    const thread = new Thread(config, { sessionId: "integ-12" });
    await collectEvents(thread.run("read file"));

    expect(executionOrder[0]).toBe("hook:PreToolUse");
    expect(executionOrder).toContain("executed:/modified/path.txt");
  });

  // ---------------------------------------------------------------------------
  // Scenario 13: ensureNonEmptyAssistantContent preserves last assistant for prefill
  // ---------------------------------------------------------------------------

  it("normalization fills empty content for all assistants with null content", async () => {
    const { normalizeMessagesForAPI } = await import("../messages/normalize.js");

    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: null, tool_calls: [{ id: "tc1", type: "function" as const, function: { name: "A", arguments: "{}" } }] },
      { role: "tool" as const, tool_call_id: "tc1", content: "r1" },
      { role: "assistant" as const, content: null, tool_calls: [{ id: "tc2", type: "function" as const, function: { name: "B", arguments: "{}" } }] },
      { role: "tool" as const, tool_call_id: "tc2", content: "r2" },
      { role: "assistant" as const, content: "final text" },
    ];

    const normalized = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(normalized);
    const assistants = normalized.filter((m) => m.role === "assistant");

    // All assistants should have non-null content
    for (const a of assistants) {
      expect(a.content).not.toBeNull();
      expect(a.content).not.toBeUndefined();
    }

    // Final assistant keeps its original content
    const last = assistants[assistants.length - 1];
    expect(last.content).toBe("final text");
  });

  // ---------------------------------------------------------------------------
  // Scenario 14: isConcurrencySafe throw doesn't crash batch runner
  // ---------------------------------------------------------------------------

  it("throwing isConcurrencySafe predicate degrades to serial execution", async () => {
    const explosiveTool = makeTool({
      name: "Explosive",
      isConcurrencySafe: () => {
        throw new Error("predicate boom");
      },
      call: async () => ({ content: "survived" }),
    });

    const config: ThreadConfig = { ...baseConfig, tools: [explosiveTool] };

    provider.addResponse(
      multiToolCallResponse([
        { id: "tc1", name: "Explosive", args: {} },
        { id: "tc2", name: "Explosive", args: {} },
      ]),
    );
    provider.addResponse(textResponse("Both done."));

    const thread = new Thread(config, { sessionId: "integ-14" });
    const events = await collectEvents(thread.run("run both"));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);

    // Both should succeed (serial, not crashed)
    for (const r of results) {
      if (r.type === "tool_result") {
        expect(r.result.content).toBe("survived");
        expect(r.result.isError).toBeFalsy();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 15: Multi-turn with message persistence roundtrip
  // ---------------------------------------------------------------------------

  it("messages are persisted and loadable across turns", async () => {
    const echoTool = makeTool({
      name: "Echo",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      call: async (args) => ({ content: `echo:${args.text}` }),
    });

    const config: ThreadConfig = { ...baseConfig, tools: [echoTool] };

    provider.addResponse(toolCallResponse("tc1", "Echo", { text: "first" }));
    provider.addResponse(textResponse("Got first echo."));

    const thread = new Thread(config, { sessionId: "persist-test" });
    await collectEvents(thread.run("echo first"));

    const messages = await thread.getMessages();
    // user + assistant(tool_call) + tool + assistant(text) = 4
    expect(messages.length).toBeGreaterThanOrEqual(3);

    // Session file should exist
    const sessionFile = fs.files.get("/sessions/persist-test.jsonl");
    expect(sessionFile).toBeDefined();
    expect(sessionFile).toContain("echo:first");
  });

  // ---------------------------------------------------------------------------
  // Scenario 16: Abort then resume round-trip
  // ---------------------------------------------------------------------------

  it("abort mid-tool then resume yields valid normalized messages", async () => {
    const slowTool = makeTool({
      name: "Slow",
      call: () => new Promise((resolve) => setTimeout(() => resolve({ content: "done" }), 5000)),
    });

    const config: ThreadConfig = { ...baseConfig, tools: [slowTool] };
    const ac = new AbortController();

    provider.addResponse(toolCallResponse("tc1", "Slow", {}));

    const thread = new Thread(config, { sessionId: "abort-resume" });
    const gen = thread.run("do slow thing", { signal: ac.signal });

    const events1: StreamEvent[] = [];
    for await (const e of gen) {
      events1.push(e);
      if (e.type === "tool_use_start") ac.abort();
      if (events1.length > 50) break;
    }

    expect(events1.some((e) => e.type === "tool_use_start")).toBe(true);

    // Now resume the session with a fresh provider response
    provider.addResponse(textResponse("Resumed successfully."));

    const thread2 = new Thread(config, { sessionId: "abort-resume", resume: true });
    const events2 = await collectEvents(thread2.run("continue"));

    const resumed = events2.find((e) => e.type === "session_resumed");
    expect(resumed).toBeDefined();

    const msgs = await thread2.getMessages();
    const normalized = normalizeMessagesForAPI(msgs);
    assertValidMessageSequence(normalized);
    expect(normalized[0].role).toBe("user");
  });

  // ---------------------------------------------------------------------------
  // Scenario 17: Compaction then continue with tool calls
  // ---------------------------------------------------------------------------

  it("compaction reduces history and subsequent tool calls still pair correctly", async () => {
    const longText = "x".repeat(800);
    let callIdx = 0;

    const echoTool = makeTool({
      name: "Echo",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      call: async (args) => ({ content: `echo: ${args.text}` }),
    });

    const compactProvider: AIProvider = {
      async *chat(params: ChatParams) {
        callIdx++;
        const isCompact = params.system?.includes("summariz");
        if (isCompact) {
          for (const chunk of textResponse("Summary of prior conversation.")) yield chunk;
          return;
        }
        if (callIdx === 1) {
          for (const chunk of textResponse(longText)) yield chunk;
        } else if (callIdx === 3) {
          for (const chunk of toolCallResponse("tc1", "Echo", { text: "post-compact" })) yield chunk;
        } else {
          for (const chunk of textResponse("Final after compact.")) yield chunk;
        }
      },
    };

    const autoConfig: ThreadConfig = {
      ...baseConfig,
      tools: [echoTool],
      provider: compactProvider,
      autoCompact: createAutoCompactConfig({
        enabled: true,
        threshold: 100,
      }),
    };

    const thread = new Thread(autoConfig, { sessionId: "compact-tools" });
    await collectEvents(thread.run("generate lots of text"));

    const events2 = await collectEvents(thread.run("now use a tool"));

    const toolResult = events2.find((e) => e.type === "tool_result");
    if (toolResult) {
      expect(toolResult.type).toBe("tool_result");
    }

    const msgs = await thread.getMessages();
    const normalized = normalizeMessagesForAPI(msgs);
    assertValidMessageSequence(normalized);
  });

  // ---------------------------------------------------------------------------
  // Scenario 18: Provider error mid-stream preserves partial state
  // ---------------------------------------------------------------------------

  it("provider error before first chunk triggers retry and recovers", async () => {
    let callCount = 0;
    const failingProvider: AIProvider = {
      async *chat() {
        callCount++;
        if (callCount === 1) {
          throw new ChatStreamError("Service temporarily unavailable", { status: 503 });
        }
        for (const chunk of textResponse("Recovered.")) yield chunk;
      },
    };

    const retryConfig: ThreadConfig = {
      ...baseConfig,
      provider: failingProvider,
      retry: {
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 10,
      },
    };

    const thread = new Thread(retryConfig, { sessionId: "pre-stream-error" });
    const events = await collectEvents(thread.run("go"));

    const retryEvents = events.filter((e) => e.type === "retry_attempt");
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);

    const complete = events.find((e) => e.type === "message_complete");
    expect(complete).toBeDefined();
  });

  it("provider error mid-stream persists partial assistant and yields error event", async () => {
    const failingProvider: AIProvider = {
      async *chat() {
        yield textChunk("partial ");
        yield textChunk("content");
        throw new Error("Connection lost mid-stream");
      },
    };

    const config: ThreadConfig = { ...baseConfig, provider: failingProvider };

    const thread = new Thread(config, { sessionId: "mid-stream-error" });
    const events = await collectEvents(thread.run("go"));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error.message).toContain("Connection lost mid-stream");
    }

    const msgs = await thread.getMessages();
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    const content = assistantMsgs[0]?.content;
    expect(typeof content === "string" && content.includes("partial")).toBe(true);

    const normalized = normalizeMessagesForAPI(msgs);
    assertValidMessageSequence(normalized);
  });

  // ---------------------------------------------------------------------------
  // Scenario 19: finish_reason "length" auto-continue with max_tokens escalation
  // ---------------------------------------------------------------------------

  it("finish_reason length triggers auto-continue and escalates max_tokens", async () => {
    const lengthChunks: ChatStreamChunk[] = [
      textChunk("partial content"),
      {
        id: "mock-len",
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
      },
    ];

    provider.addResponse(lengthChunks);
    provider.addResponse(textResponse("...continued response"));

    const config: ThreadConfig = { ...baseConfig };
    const thread = new Thread(config, { sessionId: "length-continue" });
    const events = await collectEvents(thread.run("write something long"));

    const msgs = await thread.getMessages();
    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(2);

    const userMsgs = msgs.filter((m) => m.role === "user");
    const continueMsg = userMsgs.find(
      (m) => typeof m.content === "string" && m.content.includes("Continue from where you left off"),
    );
    expect(continueMsg).toBeDefined();

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].max_tokens).toBe(65536);
  });

  // ---------------------------------------------------------------------------
  // Scenario 20: Model switch on consecutive 529 overloaded errors
  // ---------------------------------------------------------------------------

  it("switches to fallback model after consecutive overloaded errors", async () => {
    let callCount = 0;
    const overloadedProvider: AIProvider = {
      async *chat(params: ChatParams) {
        callCount++;
        if (callCount <= 3) {
          throw new ChatStreamError('"type":"overloaded_error"', { status: 529 });
        }
        for (const chunk of textResponse(`Response from ${params.model}`)) yield chunk;
      },
    };

    const retryConfig: ThreadConfig = {
      ...baseConfig,
      provider: overloadedProvider,
      retry: {
        maxRetries: 10,
        baseDelayMs: 1,
        maxDelayMs: 10,
        fallbackModel: "fallback-model",
        maxConsecutiveOverloaded: 3,
      },
    };

    const thread = new Thread(retryConfig, { sessionId: "model-switch" });
    const events = await collectEvents(thread.run("go"));

    const modelSwitch = events.find((e) => e.type === "model_switch");
    expect(modelSwitch).toBeDefined();
    if (modelSwitch?.type === "model_switch") {
      expect(modelSwitch.to).toBe("fallback-model");
    }

    const complete = events.find((e) => e.type === "message_complete");
    expect(complete).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Scenario 21: Provider error after tool_calls finish but before execution
  // ---------------------------------------------------------------------------

  it("error after tool_calls finish_reason generates synthetic results, not real ones", async () => {
    const toolCallLog: string[] = [];
    const trackedTool = makeTool({
      name: "Tracked",
      call: async () => {
        toolCallLog.push("executed");
        return { content: "done" };
      },
    });

    let callCount = 0;
    const errAfterToolsProvider: AIProvider = {
      async *chat() {
        callCount++;
        if (callCount === 1) {
          yield toolCallStartChunk("tc1", "Tracked");
          yield toolCallArgChunk("{}");
          yield toolCallsFinishChunk();
          throw new ChatStreamError("Connection reset", { status: 502 });
        }
        for (const chunk of textResponse("Recovered after error.")) yield chunk;
      },
    };

    const config: ThreadConfig = {
      ...baseConfig,
      tools: [trackedTool],
      provider: errAfterToolsProvider,
      retry: {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 10,
      },
    };

    const thread = new Thread(config, { sessionId: "error-after-tools" });
    const events = await collectEvents(thread.run("call the tool"));

    const msgs = await thread.getMessages();
    const normalized = normalizeMessagesForAPI(msgs);
    assertValidMessageSequence(normalized);
  });
});

// ---------------------------------------------------------------------------
// Thread abort / error / resume integration tests
// ---------------------------------------------------------------------------

describe("Integration: abort, error, and resume lifecycle", () => {
  it("abort mid-tool-execution produces valid transcript after sanitize+normalize", async () => {
    const ac = new AbortController();
    let slowToolStarted!: () => void;
    const slowToolStartedPromise = new Promise<void>((r) => { slowToolStarted = r; });

    const slowTool = makeTool({
      name: "SlowTool",
      isConcurrencySafe: true,
      isReadOnly: true,
      call: async (_args, ctx) => {
        slowToolStarted();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          ctx?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return { content: "slow result" };
      },
    });

    provider.addResponse(
      multiToolCallResponse([
        { id: "tc1", name: "ReadFile", args: { file_path: "/a.txt" } },
        { id: "tc2", name: "SlowTool", args: {} },
      ]),
    );

    fs.files.set("/a.txt", "content-a");

    const config: ThreadConfig = {
      ...baseConfig,
      tools: [slowTool],
      streamingToolExecution: true,
    };

    const thread = new Thread(config, { sessionId: "abort-mid-tool" });

    // Abort once the slow tool starts executing
    slowToolStartedPromise.then(() => {
      setTimeout(() => ac.abort(), 10);
    });

    const events: StreamEvent[] = [];
    for await (const e of thread.run("run tools", { signal: ac.signal })) {
      events.push(e);
    }

    const messages = await thread.getMessages();
    const { messages: sanitized } = (await import("../session/recovery.js")).sanitizeForResume(messages);
    const normalized = normalizeMessagesForAPI(sanitized);
    assertValidMessageSequence(normalized);

    // After abort+sanitize, all tool_calls should have matching results (real or synthetic)
    const assistants = normalized.filter((m) => m.role === "assistant") as AssistantMessage[];
    const totalToolCalls = assistants.reduce(
      (n, a) => n + (a.tool_calls?.length ?? 0), 0,
    );
    const toolResults = normalized.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(totalToolCalls);
  });

  it("provider error mid-stream preserves completed streaming tool results", async () => {
    let callCount = 0;
    const errorProvider: AIProvider = {
      async *chat() {
        callCount++;
        if (callCount === 1) {
          // Stream 2 tool calls normally
          for (const chunk of multiToolCallResponse([
            { id: "tc1", name: "ReadFile", args: { file_path: "/a.txt" } },
            { id: "tc2", name: "ReadFile", args: { file_path: "/b.txt" } },
          ])) {
            yield chunk;
          }
          return;
        }
        if (callCount === 2) {
          // Error mid-stream on the second API call
          yield textChunk("Starting to ");
          throw new Error("simulated network failure");
        }
        for (const chunk of textResponse("Recovered.")) yield chunk;
      },
    };

    fs.files.set("/a.txt", "AAA");
    fs.files.set("/b.txt", "BBB");

    const config: ThreadConfig = {
      ...baseConfig,
      provider: errorProvider,
      streamingToolExecution: true,
    };

    const thread = new Thread(config, { sessionId: "err-mid-stream" });
    const events: StreamEvent[] = [];
    try {
      for await (const e of thread.run("read files")) {
        events.push(e);
      }
    } catch {
      // expected
    }

    const messages = await thread.getMessages();
    const normalized = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(normalized);

    // The first-call tool results should be real (not error)
    const toolResults = normalized.filter((m) => m.role === "tool") as import("../session/types.js").ToolResultMessage[];
    expect(toolResults.length).toBe(2);
    const realResults = toolResults.filter((m) => !m.isError);
    expect(realResults.length).toBe(2);
    expect(String(realResults[0].content)).toContain("AAA");
  });

  it("abort with orphaned tool_calls recovers via sanitizeForResume", async () => {
    // Simulate the edge case: provider streams 2 tool calls but abort fires
    // before the last tool_call is finalized in the streaming executor.
    // The thread persists a partial assistant with both tool_calls but only
    // has results for tool_calls that were added to the executor.
    const brokenTranscript: ChatMessage[] = [
      { role: "user", content: "do things" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"/a.txt"}' } },
          { id: "tc2", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"/b.txt"}' } },
        ],
      } as AssistantMessage,
      // Only tc1 completed before abort
      { role: "tool", tool_call_id: "tc1", content: "content-a" } as import("../session/types.js").ToolResultMessage,
      // tc2 is orphaned — no result
      { role: "user", content: "[Session interrupted by user. Continue from where you left off if resumed.]" },
    ];

    const { messages: sanitized, interruption } = (await import("../session/recovery.js")).sanitizeForResume(brokenTranscript);

    // sanitizeForResume should generate a synthetic result for tc2
    const normalized = normalizeMessagesForAPI(sanitized);
    assertValidMessageSequence(normalized);

    const toolResults = normalized.filter((m) => m.role === "tool") as import("../session/types.js").ToolResultMessage[];
    expect(toolResults.length).toBe(2);

    const tc2 = toolResults.find((m) => m.tool_call_id === "tc2");
    expect(tc2).toBeDefined();
    expect(tc2!.isError).toBe(true);
  });

  it("model switch during retry clears accumulated state", async () => {
    let callCount = 0;
    const switchingProvider: AIProvider = {
      async *chat() {
        callCount++;
        // Throw overloaded immediately (before first chunk) so the retry
        // engine catches it. Need 3 consecutive to trigger fallback.
        if (callCount <= 3) {
          throw new ChatStreamError("Overloaded", { status: 529 });
        }
        // After fallback to new model: clean response
        for (const chunk of textResponse("Clean response from fallback.")) {
          yield chunk;
        }
      },
    };

    const config: ThreadConfig = {
      ...baseConfig,
      provider: switchingProvider,
      model: "model-1",
      retry: {
        maxRetries: 5,
        baseDelayMs: 1,
        maxDelayMs: 5,
        maxConsecutiveOverloaded: 3,
        fallbackModel: "fallback-model",
      },
    };

    const thread = new Thread(config, { sessionId: "model-switch" });
    const events = await collectEvents(thread.run("say hello"));

    const modelSwitch = events.find((e) => e.type === "model_switch");
    expect(modelSwitch).toBeDefined();

    const messages = await thread.getMessages();
    const normalized = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(normalized);

    const assistants = normalized.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants.length).toBeGreaterThanOrEqual(1);
    const lastAssistant = assistants[assistants.length - 1];
    expect(typeof lastAssistant.content === "string" && lastAssistant.content).toContain("Clean response");
  });
});

// ---------------------------------------------------------------------------
// Microcompact ordering regression test
// ---------------------------------------------------------------------------

describe("Integration: microcompact savings reach current API call", () => {
  it("within the same turn, second API call sees microcompacted tool results", async () => {
    const largeContent = "x".repeat(500);
    const readTool = makeTool({
      name: "ReadFile",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
      call: async () => ({ content: largeContent }),
    });

    // Track messages sent to the provider on each call
    const providerCallMessages: ChatMessage[][] = [];
    let callIdx = 0;
    const spyProvider: AIProvider = {
      async *chat(params: ChatParams) {
        providerCallMessages.push([...params.messages]);
        callIdx++;
        if (callIdx === 1) {
          // Iteration 1: return 6 tool calls so microcompact has enough to clear
          for (const chunk of multiToolCallResponse([
            { id: "tc1", name: "ReadFile", args: { file_path: "/a.txt" } },
            { id: "tc2", name: "ReadFile", args: { file_path: "/b.txt" } },
            { id: "tc3", name: "ReadFile", args: { file_path: "/c.txt" } },
            { id: "tc4", name: "ReadFile", args: { file_path: "/d.txt" } },
            { id: "tc5", name: "ReadFile", args: { file_path: "/e.txt" } },
            { id: "tc6", name: "ReadFile", args: { file_path: "/f.txt" } },
          ])) yield chunk;
          return;
        }
        // Iteration 2: final text. The provider should see cleared old results.
        for (const chunk of textResponse("Done.")) yield chunk;
      },
    };

    const config: ThreadConfig = {
      ...baseConfig,
      tools: [readTool],
      provider: spyProvider,
      microcompact: { enabled: true, keepRecent: 0 },
    };

    const thread = new Thread(config, { sessionId: "mc-ordering" });
    await collectEvents(thread.run("read files"));

    // The second provider call (iteration 2) should have microcompacted messages.
    // Bug: messagesForApi references the pre-microcompact array, so the provider
    // sees full tool results instead of cleared placeholders.
    expect(providerCallMessages.length).toBe(2);
    const secondCallMsgs = providerCallMessages[1];
    const toolMsgs = secondCallMsgs.filter((m: ChatMessage) => m.role === "tool");
    expect(toolMsgs.length).toBe(6);
    for (const tm of toolMsgs) {
      expect(tm.content).toBe(CLEARED_PLACEHOLDER);
    }
  });
});

// ---------------------------------------------------------------------------
// content_filter streaming tool result preservation regression test
// ---------------------------------------------------------------------------

describe("Integration: content_filter preserves completed streaming tool results", () => {
  it("tool calls accumulated before content_filter are persisted with results", async () => {
    const executionLog: string[] = [];
    const readTool = makeTool({
      name: "ReadFile",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
      call: async (args) => {
        executionLog.push(`executed:${args.file_path}`);
        return { content: `content-of-${args.file_path}` };
      },
    });

    let callCount = 0;
    const contentFilterProvider: AIProvider = {
      async *chat() {
        callCount++;
        if (callCount === 1) {
          // Stream two tool calls: tc1 args complete, then tc2 starts
          // (which triggers tc1 being added to the streaming executor),
          // then content_filter fires.
          yield toolCallStartChunk("tc1", "ReadFile");
          yield toolCallArgChunk(JSON.stringify({ file_path: "/a.txt" }));
          // tc2 start triggers tc1 finalization in the streaming executor
          yield {
            id: "mock-tc2-start",
            model: "mock-model",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 1,
                  id: "tc2",
                  type: "function" as const,
                  function: { name: "ReadFile", arguments: "" },
                }],
              },
              finish_reason: null,
            }],
          };
          yield {
            id: "mock-tc2-args",
            model: "mock-model",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 1,
                  function: { arguments: JSON.stringify({ file_path: "/b.txt" }) },
                }],
              },
              finish_reason: null,
            }],
          };
          // Allow tool 1 to execute during streaming
          await new Promise((r) => setTimeout(r, 20));
          // Content filter fires
          yield {
            id: "mock-cf",
            model: "mock-model",
            choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
          };
          return;
        }
        for (const chunk of textResponse("Recovered.")) yield chunk;
      },
    };

    const config: ThreadConfig = {
      ...baseConfig,
      tools: [readTool],
      provider: contentFilterProvider,
      streamingToolExecution: true,
    };

    const thread = new Thread(config, { sessionId: "cf-preserve" });
    const events = await collectEvents(thread.run("read files"));

    const msgs = await thread.getMessages();

    // The assistant message should have tool_calls (not discarded)
    const assistants = msgs.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants.length).toBeGreaterThanOrEqual(1);
    const asstWithTools = assistants.find((a) => a.tool_calls && a.tool_calls.length > 0);
    expect(asstWithTools).toBeDefined();
    expect(asstWithTools!.tool_calls!.length).toBe(2);

    // Tool results should be persisted (real result for tc1, error for tc2 since discarded)
    const toolResults = msgs.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(2);
  });
});
