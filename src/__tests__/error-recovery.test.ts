import { describe, it, expect, vi } from "vitest";
import { buildPartialResults, tryReactiveCompactRecovery } from "../pipeline/error-recovery.js";
import type { StreamingExecResult } from "../tools/streaming-executor.js";
import type { ToolCallContent, AssistantMessage, ChatMessage } from "../session/types.js";
import { tryReactiveCompact } from "../compact/reactive-compact.js";
import { runNotificationHooks } from "../hooks/runner.js";

vi.mock("../compact/reactive-compact.js", () => ({
  tryReactiveCompact: vi.fn(),
}));

vi.mock("../hooks/runner.js", () => ({
  runNotificationHooks: vi.fn().mockResolvedValue(undefined),
}));

const mockTryReactiveCompact = tryReactiveCompact as ReturnType<typeof vi.fn>;
const mockRunNotificationHooks = runNotificationHooks as ReturnType<typeof vi.fn>;

function makeToolCall(id: string, name: string, args = "{}"): ToolCallContent {
  return { id, type: "function", function: { name, arguments: args } };
}

function makeStreamingResult(
  id: string,
  name: string,
  content: string,
  isError = false,
): StreamingExecResult {
  return {
    toolCall: makeToolCall(id, name),
    parsedArgs: {},
    result: { content, ...(isError ? { isError: true } : {}) },
    events: [],
  };
}

describe("buildPartialResults", () => {
  it("returns empty messages when no accumulated state", () => {
    const result = buildPartialResults({
      accumulatedToolCalls: new Map(),
      accumulatedContent: [],
      completedStreamingResults: [],
      reason: "some error",
    });
    expect(result.messages).toEqual([]);
  });

  it("builds text-only interruption with no tool calls", () => {
    const result = buildPartialResults({
      accumulatedToolCalls: new Map(),
      accumulatedContent: ["Hello ", "world"],
      completedStreamingResults: [],
      reason: "some error",
    });
    expect(result.messages).toHaveLength(1);
    const assistant = result.messages[0] as AssistantMessage;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Hello world");
    expect(assistant.tool_calls).toBeUndefined();
  });

  it("builds assistant + real results + synthetic results for tool calls", () => {
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    toolCalls.set(0, { id: "tc_1", name: "ReadFile", arguments: '{"path":"a.txt"}' });
    toolCalls.set(1, { id: "tc_2", name: "WriteFile", arguments: '{"path":"b.txt"}' });

    const completed = [makeStreamingResult("tc_1", "ReadFile", "file contents")];

    const result = buildPartialResults({
      accumulatedToolCalls: toolCalls,
      accumulatedContent: ["Analyzing..."],
      completedStreamingResults: completed,
      reason: "Provider error: timeout",
    });

    // 1 assistant + 1 real result + 1 synthetic error
    expect(result.messages).toHaveLength(3);

    const assistant = result.messages[0] as AssistantMessage;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toContain("Analyzing...");
    expect(assistant.content).toContain("[Response interrupted: Provider error: timeout]");
    expect(assistant.tool_calls).toHaveLength(2);

    const realResult = result.messages[1];
    expect(realResult.role).toBe("tool");
    expect((realResult as any).tool_call_id).toBe("tc_1");
    expect((realResult as any).content).toBe("file contents");

    const syntheticResult = result.messages[2];
    expect(syntheticResult.role).toBe("tool");
    expect((syntheticResult as any).tool_call_id).toBe("tc_2");
    expect((syntheticResult as any).content).toContain("Error:");
    expect((syntheticResult as any).isError).toBe(true);
  });

  it("builds interruption without text when only tool calls accumulated", () => {
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    toolCalls.set(0, { id: "tc_1", name: "Bash", arguments: '{}' });

    const result = buildPartialResults({
      accumulatedToolCalls: toolCalls,
      accumulatedContent: [],
      completedStreamingResults: [],
      reason: "Stream error: connection reset",
    });

    expect(result.messages).toHaveLength(2); // assistant + 1 synthetic
    const assistant = result.messages[0] as AssistantMessage;
    expect(assistant.content).toBe("[Response interrupted: Stream error: connection reset]");
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it("preserves isError flag from completed streaming results", () => {
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    toolCalls.set(0, { id: "tc_1", name: "Bash", arguments: '{}' });

    const completed = [makeStreamingResult("tc_1", "Bash", "command failed", true)];

    const result = buildPartialResults({
      accumulatedToolCalls: toolCalls,
      accumulatedContent: [],
      completedStreamingResults: completed,
      reason: "error",
    });

    expect(result.messages).toHaveLength(2); // assistant + 1 real (all covered, no synthetic)
    const toolResult = result.messages[1];
    expect((toolResult as any).isError).toBe(true);
    expect((toolResult as any).content).toBe("command failed");
  });

  it("omits interruption tag when includeInterruptionTag is false", () => {
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    toolCalls.set(0, { id: "tc_1", name: "ReadFile", arguments: '{}' });

    const completed = [makeStreamingResult("tc_1", "ReadFile", "data")];

    const result = buildPartialResults({
      accumulatedToolCalls: toolCalls,
      accumulatedContent: ["Some text"],
      completedStreamingResults: completed,
      reason: "abort",
      includeInterruptionTag: false,
    });

    const assistant = result.messages[0] as AssistantMessage;
    expect(assistant.content).toBe("Some text");
    expect(assistant.content).not.toContain("[Response interrupted");
  });

  it("generates synthetic results for existing messages when no accumulated state", () => {
    const existingAssistant: AssistantMessage = {
      role: "assistant",
      content: "Let me help",
      tool_calls: [makeToolCall("tc_old", "ReadFile")],
    };

    const result = buildPartialResults({
      accumulatedToolCalls: new Map(),
      accumulatedContent: [],
      completedStreamingResults: [],
      reason: "Provider error: rate limit",
      existingMessages: [existingAssistant],
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect((result.messages[0] as any).tool_call_id).toBe("tc_old");
    expect((result.messages[0] as any).isError).toBe(true);
  });

  it("does not generate synthetic results for existing messages when tool results exist", () => {
    const existingAssistant: AssistantMessage = {
      role: "assistant",
      content: "Let me help",
      tool_calls: [makeToolCall("tc_old", "ReadFile")],
    };
    const existingToolResult: ChatMessage = {
      role: "tool",
      tool_call_id: "tc_old",
      content: "file data",
    };

    const result = buildPartialResults({
      accumulatedToolCalls: new Map(),
      accumulatedContent: [],
      completedStreamingResults: [],
      reason: "Provider error: rate limit",
      existingMessages: [existingAssistant, existingToolResult],
    });

    expect(result.messages).toHaveLength(0);
  });
});

describe("tryReactiveCompactRecovery", () => {
  it("emits compact_start and compact_complete on successful recovery", async () => {
    const mockMessages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "do stuff" },
    ];
    const compactedMessages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "[compacted]" },
    ];

    mockTryReactiveCompact.mockResolvedValueOnce({
      messages: compactedMessages,
      strategy: "compacted",
    });

    const result = await tryReactiveCompactRecovery({
      provider: {} as any,
      model: "test-model",
      messages: mockMessages,
      storage: {} as any,
      sessionId: "sess-1",
      signal: new AbortController().signal,
      hooks: [],
    });

    expect(result.recovered).toBe(true);
    expect(result.messages).toEqual(compactedMessages);
    const types = result.events.map((e) => e.type);
    expect(types).toContain("compact_start");
    expect(types).toContain("compact_complete");
  });

  it("emits events even when recovery fails", async () => {
    mockTryReactiveCompact.mockResolvedValueOnce(null);

    const result = await tryReactiveCompactRecovery({
      provider: {} as any,
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      storage: {} as any,
      sessionId: "sess-2",
      signal: new AbortController().signal,
      hooks: [],
    });

    expect(result.recovered).toBe(false);
    expect(result.messages).toBeUndefined();
    const types = result.events.map((e) => e.type);
    expect(types).toContain("compact_start");
    expect(types).toContain("compact_complete");
  });

  it("calls hooks with correct event names", async () => {
    mockTryReactiveCompact.mockResolvedValueOnce(null);
    mockRunNotificationHooks.mockClear();

    const hooks = [{ event: "PreCompact" as const, handler: vi.fn() }];
    await tryReactiveCompactRecovery({
      provider: {} as any,
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      storage: {} as any,
      sessionId: "sess-3",
      signal: new AbortController().signal,
      hooks: hooks as any,
    });

    expect(mockRunNotificationHooks).toHaveBeenCalledTimes(2);
    expect(mockRunNotificationHooks.mock.calls[0][1]).toBe("PreCompact");
    expect(mockRunNotificationHooks.mock.calls[1][1]).toBe("PostCompact");
  });
});
