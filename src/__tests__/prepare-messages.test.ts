import { describe, it, expect } from "vitest";
import { prepareMessagesForApi } from "../pipeline/prepare-messages.js";
import { createBudgetState } from "../compact/tool-result-budget.js";
import { createContentReplacementState } from "../compact/tool-result-storage.js";
import type { ChatMessage, StreamEvent } from "../session/types.js";
import { CLEARED_PLACEHOLDER } from "../compact/microcompact.js";
import { assertValidMessageSequence } from "../messages/invariants.js";

function makeToolCallAssistant(callId: string, toolName: string): ChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: callId,
        type: "function" as const,
        function: { name: toolName, arguments: "{}" },
      },
    ],
  };
}

function makeToolResult(callId: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: callId, content };
}

function initialState() {
  return {
    contentReplacementState: createContentReplacementState(),
    budgetState: createBudgetState(),
    microcompactTokensFreed: 0,
  };
}

describe("prepareMessagesForApi", () => {
  it("returns normalized valid output when all stages are disabled", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const result = await prepareMessagesForApi(messages, {
      sessionId: "test-1",
    }, initialState());

    expect(result.canonicalMessages).toEqual(messages);
    assertValidMessageSequence(result.messagesForApi);
    expect(result.events).toEqual([]);
    expect(result.state.microcompactTokensFreed).toBe(0);
  });

  it("microcompact clears old compactable results and emits event", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "start" },
    ];

    for (let i = 0; i < 8; i++) {
      const callId = `call-${i}`;
      messages.push(makeToolCallAssistant(callId, "ReadFile"));
      messages.push(makeToolResult(callId, "x".repeat(500)));
    }
    messages.push({ role: "assistant", content: "done" });

    const result = await prepareMessagesForApi(messages, {
      sessionId: "test-mc",
      microcompact: { enabled: true, keepRecent: 5 },
    }, initialState());

    const clearedResults = result.canonicalMessages.filter(
      (m) => m.role === "tool" && m.content === CLEARED_PLACEHOLDER,
    );
    expect(clearedResults.length).toBe(3);

    const mcEvents = result.events.filter((e) => e.type === "microcompact_complete");
    expect(mcEvents.length).toBe(1);
    expect((mcEvents[0] as { tokensFreed: number }).tokensFreed).toBeGreaterThan(0);
  });

  it("budget truncates large tool results on snapshot without mutating canonical", async () => {
    const bigContent = "x".repeat(60_000);
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      makeToolCallAssistant("tc-1", "SomeTool"),
      makeToolResult("tc-1", bigContent),
      { role: "assistant", content: "ok" },
    ];

    const result = await prepareMessagesForApi(messages, {
      sessionId: "test-budget",
      toolResultBudget: { enabled: true, maxCharsPerResult: 10_000, previewChars: 500 },
    }, initialState());

    const canonicalToolResult = result.canonicalMessages.find(
      (m) => m.role === "tool" && m.tool_call_id === "tc-1",
    );
    expect(canonicalToolResult!.content).toBe(bigContent);

    const apiToolResult = result.messagesForApi.find(
      (m) => m.role === "tool" && (m as { tool_call_id?: string }).tool_call_id === "tc-1",
    );
    expect((apiToolResult!.content as string).length).toBeLessThan(bigContent.length);

    const truncEvents = result.events.filter((e) => e.type === "tool_result_truncated");
    expect(truncEvents.length).toBe(1);
    expect((truncEvents[0] as { toolCallId: string }).toolCallId).toBe("tc-1");
  });

  it("budget disabled means messagesForApi reflects microcompact directly", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
    ];

    const result = await prepareMessagesForApi(messages, {
      sessionId: "test-no-budget",
      microcompact: { enabled: false },
    }, initialState());

    assertValidMessageSequence(result.messagesForApi);
    expect(result.events).toEqual([]);
  });

  it("events array contains tool_result_truncated for each budget truncation", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      makeToolCallAssistant("a", "ToolA"),
      makeToolResult("a", "x".repeat(60_000)),
      makeToolCallAssistant("b", "ToolB"),
      makeToolResult("b", "y".repeat(60_000)),
      { role: "assistant", content: "done" },
    ];

    const result = await prepareMessagesForApi(messages, {
      sessionId: "test-multi-trunc",
      toolResultBudget: { enabled: true, maxCharsPerResult: 10_000, previewChars: 200 },
    }, initialState());

    const truncEvents = result.events.filter((e) => e.type === "tool_result_truncated");
    expect(truncEvents.length).toBe(2);
    const ids = truncEvents.map((e) => (e as { toolCallId: string }).toolCallId);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("state is returned correctly (not mutated in place)", async () => {
    const state = initialState();
    const origBudgetState = state.budgetState;
    const origContentState = state.contentReplacementState;

    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      makeToolCallAssistant("tc-1", "ReadFile"),
      makeToolResult("tc-1", "x".repeat(500)),
      makeToolCallAssistant("tc-2", "ReadFile"),
      makeToolResult("tc-2", "y".repeat(500)),
      makeToolCallAssistant("tc-3", "ReadFile"),
      makeToolResult("tc-3", "z".repeat(500)),
      makeToolCallAssistant("tc-4", "ReadFile"),
      makeToolResult("tc-4", "w".repeat(500)),
      makeToolCallAssistant("tc-5", "ReadFile"),
      makeToolResult("tc-5", "a".repeat(500)),
      makeToolCallAssistant("tc-6", "ReadFile"),
      makeToolResult("tc-6", "b".repeat(500)),
      { role: "assistant", content: "done" },
    ];

    const result = await prepareMessagesForApi(messages, {
      sessionId: "test-state",
      microcompact: { enabled: true, keepRecent: 5 },
    }, state);

    expect(state.budgetState).toBe(origBudgetState);
    expect(state.contentReplacementState).toBe(origContentState);
    expect(state.microcompactTokensFreed).toBe(0);
    expect(result.state.microcompactTokensFreed).toBeGreaterThan(0);
  });

  it("debug mode asserts valid message sequence without throwing", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];

    await expect(
      prepareMessagesForApi(messages, {
        sessionId: "test-debug",
        debug: true,
      }, initialState()),
    ).resolves.toBeDefined();
  });

  it("microcompact tokens freed accumulates across stages", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 8; i++) {
      const callId = `call-${i}`;
      messages.push(makeToolCallAssistant(callId, "ReadFile"));
      messages.push(makeToolResult(callId, "data".repeat(200)));
    }
    messages.push({ role: "assistant", content: "done" });

    const state = initialState();
    state.microcompactTokensFreed = 100;

    const result = await prepareMessagesForApi(messages, {
      sessionId: "test-accum",
      microcompact: { enabled: true, keepRecent: 5 },
    }, state);

    expect(result.state.microcompactTokensFreed).toBeGreaterThan(100);
  });
});
