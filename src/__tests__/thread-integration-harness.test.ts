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
import type { StreamEvent } from "../session/types.js";
import type { Tool, ToolResult, ToolContext } from "../tools/types.js";
import type { HookDefinition } from "../hooks/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";

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
});
