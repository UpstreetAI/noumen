import { describe, it, expect } from "vitest";
import {
  separateToolCalls,
  buildAssistantMessage,
  generateMalformedToolResults,
  accumulateUsage,
} from "../pipeline/build-assistant-response.js";
import { createAccumulator } from "../pipeline/consume-stream.js";
import type { StreamAccumulator } from "../pipeline/consume-stream.js";
import type { ChatCompletionUsage } from "../providers/types.js";

function makeAccumulator(overrides?: Partial<StreamAccumulator>): StreamAccumulator {
  return { ...createAccumulator(), ...overrides };
}

function addToolCall(
  acc: StreamAccumulator,
  idx: number,
  opts: { id: string; name: string; args: string; malformed?: boolean },
): void {
  acc.toolCalls.set(idx, {
    id: opts.id,
    name: opts.name,
    arguments: opts.args,
    complete: true,
    malformedJson: opts.malformed,
  });
}

// ---------------------------------------------------------------------------
// separateToolCalls
// ---------------------------------------------------------------------------

describe("separateToolCalls", () => {
  it("separates all-valid tool calls", () => {
    const acc = makeAccumulator();
    addToolCall(acc, 0, { id: "tc1", name: "read", args: '{"path": "/a"}' });
    addToolCall(acc, 1, { id: "tc2", name: "write", args: '{"data": 1}' });

    const { valid, malformed } = separateToolCalls(acc, false);

    expect(valid).toHaveLength(2);
    expect(malformed).toHaveLength(0);
    expect(valid[0]).toEqual({
      id: "tc1",
      type: "function",
      function: { name: "read", arguments: '{"path": "/a"}' },
    });
  });

  it("separates all-malformed tool calls", () => {
    const acc = makeAccumulator();
    addToolCall(acc, 0, { id: "tc1", name: "read", args: "not json", malformed: true });
    addToolCall(acc, 1, { id: "tc2", name: "write", args: "{bad}", malformed: true });

    const { valid, malformed } = separateToolCalls(acc, false);

    expect(valid).toHaveLength(0);
    expect(malformed).toHaveLength(2);
    expect(malformed[0]).toEqual({ id: "tc1", name: "read" });
  });

  it("separates mixed valid and malformed tool calls", () => {
    const acc = makeAccumulator();
    addToolCall(acc, 0, { id: "tc1", name: "read", args: '{"ok": true}' });
    addToolCall(acc, 1, { id: "tc2", name: "write", args: "broken{", malformed: true });

    const { valid, malformed } = separateToolCalls(acc, false);

    expect(valid).toHaveLength(1);
    expect(malformed).toHaveLength(1);
    expect(valid[0].id).toBe("tc1");
    expect(malformed[0].id).toBe("tc2");
  });

  it("returns empty arrays when no tool calls", () => {
    const acc = makeAccumulator();
    const { valid, malformed } = separateToolCalls(acc, false);
    expect(valid).toHaveLength(0);
    expect(malformed).toHaveLength(0);
  });

  it("detects malformed JSON via parse in non-streaming mode", () => {
    const acc = makeAccumulator();
    addToolCall(acc, 0, { id: "tc1", name: "read", args: "{invalid json}" });

    const { valid, malformed } = separateToolCalls(acc, false);

    expect(valid).toHaveLength(0);
    expect(malformed).toHaveLength(1);
    expect(malformed[0].id).toBe("tc1");
  });

  it("skips JSON.parse check in streaming mode (uses malformedJson flag)", () => {
    const acc = makeAccumulator();
    addToolCall(acc, 0, { id: "tc1", name: "read", args: "{invalid json}" });

    const { valid, malformed } = separateToolCalls(acc, true);

    expect(valid).toHaveLength(1);
    expect(malformed).toHaveLength(0);
  });

  it("streaming mode respects malformedJson flag", () => {
    const acc = makeAccumulator();
    addToolCall(acc, 0, { id: "tc1", name: "read", args: "{invalid json}", malformed: true });

    const { valid, malformed } = separateToolCalls(acc, true);

    expect(valid).toHaveLength(0);
    expect(malformed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildAssistantMessage
// ---------------------------------------------------------------------------

describe("buildAssistantMessage", () => {
  it("builds text-only message", () => {
    const acc = makeAccumulator({ content: ["Hello ", "world"] });
    const msg = buildAssistantMessage({
      acc,
      validToolCalls: [],
      malformedToolCalls: [],
      turnId: "sess:1",
    });

    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("Hello world");
    expect(msg.tool_calls).toBeUndefined();
    expect(msg.thinking_content).toBeUndefined();
    expect(msg._turnId).toBe("sess:1");
  });

  it("builds message with valid tool calls", () => {
    const acc = makeAccumulator({ content: ["text"] });
    const msg = buildAssistantMessage({
      acc,
      validToolCalls: [{ id: "tc1", type: "function", function: { name: "read", arguments: "{}" } }],
      malformedToolCalls: [],
      turnId: "sess:2",
    });

    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0].id).toBe("tc1");
  });

  it("includes malformed tool calls with empty args", () => {
    const acc = makeAccumulator();
    const msg = buildAssistantMessage({
      acc,
      validToolCalls: [],
      malformedToolCalls: [{ id: "tc1", name: "bad" }],
      turnId: "sess:3",
    });

    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0].function.arguments).toBe("{}");
    expect(msg.tool_calls![0].function.name).toBe("bad");
  });

  it("combines valid and malformed tool calls", () => {
    const acc = makeAccumulator();
    const msg = buildAssistantMessage({
      acc,
      validToolCalls: [{ id: "tc1", type: "function", function: { name: "read", arguments: '{"p":1}' } }],
      malformedToolCalls: [{ id: "tc2", name: "bad" }],
      turnId: "sess:4",
    });

    expect(msg.tool_calls).toHaveLength(2);
    expect(msg.tool_calls![0].id).toBe("tc1");
    expect(msg.tool_calls![1].id).toBe("tc2");
    expect(msg.tool_calls![1].function.arguments).toBe("{}");
  });

  it("includes thinking content", () => {
    const acc = makeAccumulator({
      thinking: ["step1 ", "step2"],
      thinkingSignature: "sig123",
    });
    const msg = buildAssistantMessage({
      acc,
      validToolCalls: [],
      malformedToolCalls: [],
      turnId: "sess:5",
    });

    expect(msg.thinking_content).toBe("step1 step2");
    expect(msg.thinking_signature).toBe("sig123");
  });

  it("includes redacted thinking data", () => {
    const acc = makeAccumulator({
      redactedThinkingData: "redacted-data",
    });
    const msg = buildAssistantMessage({
      acc,
      validToolCalls: [],
      malformedToolCalls: [],
      turnId: "sess:6",
    });

    expect(msg.redacted_thinking_data).toBe("redacted-data");
  });

  it("returns null content when accumulator content is empty", () => {
    const acc = makeAccumulator();
    const msg = buildAssistantMessage({
      acc,
      validToolCalls: [],
      malformedToolCalls: [],
      turnId: "sess:7",
    });

    expect(msg.content).toBeNull();
  });

  it("omits thinking_content when thinking is empty", () => {
    const acc = makeAccumulator({ thinking: [] });
    const msg = buildAssistantMessage({
      acc,
      validToolCalls: [],
      malformedToolCalls: [],
      turnId: "sess:8",
    });

    expect(msg.thinking_content).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateMalformedToolResults
// ---------------------------------------------------------------------------

describe("generateMalformedToolResults", () => {
  it("returns empty arrays for no malformed calls", () => {
    const result = generateMalformedToolResults([]);
    expect(result.messages).toHaveLength(0);
    expect(result.events).toHaveLength(0);
  });

  it("generates error results for a single malformed call", () => {
    const result = generateMalformedToolResults([{ id: "tc1", name: "read" }]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tc1",
      content: "Error: Invalid tool call arguments for read (malformed JSON)",
      isError: true,
    });

    expect(result.events).toHaveLength(1);
    const evt = result.events[0] as { type: string; toolUseId: string; toolName: string };
    expect(evt.type).toBe("tool_result");
    expect(evt.toolUseId).toBe("tc1");
    expect(evt.toolName).toBe("read");
  });

  it("generates error results for multiple malformed calls", () => {
    const result = generateMalformedToolResults([
      { id: "tc1", name: "read" },
      { id: "tc2", name: "write" },
      { id: "tc3", name: "exec" },
    ]);

    expect(result.messages).toHaveLength(3);
    expect(result.events).toHaveLength(3);

    expect(result.messages[1].content).toContain("write");
    expect(result.messages[2].content).toContain("exec");
  });
});

// ---------------------------------------------------------------------------
// accumulateUsage
// ---------------------------------------------------------------------------

describe("accumulateUsage", () => {
  function emptyUsage(): ChatCompletionUsage {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  it("returns no-op when usage is undefined", () => {
    const turnUsage = emptyUsage();
    const result = accumulateUsage({
      usage: undefined,
      turnUsage,
      model: "gpt-4",
      messagesLength: 5,
    });

    expect(result.events).toHaveLength(0);
    expect(result.lastUsage).toBeUndefined();
    expect(result.anchorMessageIndex).toBeUndefined();
    expect(result.resetMicrocompactTokensFreed).toBe(false);
    expect(turnUsage.prompt_tokens).toBe(0);
  });

  it("accumulates full usage and emits event", () => {
    const turnUsage = emptyUsage();
    const usage: ChatCompletionUsage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 10,
      cache_creation_tokens: 5,
      thinking_tokens: 20,
    };

    const result = accumulateUsage({
      usage,
      turnUsage,
      model: "claude-3",
      messagesLength: 8,
    });

    expect(turnUsage.prompt_tokens).toBe(100);
    expect(turnUsage.completion_tokens).toBe(50);
    expect(turnUsage.total_tokens).toBe(150);
    expect(turnUsage.cache_read_tokens).toBe(10);
    expect(turnUsage.cache_creation_tokens).toBe(5);
    expect(turnUsage.thinking_tokens).toBe(20);

    expect(result.lastUsage).toBe(usage);
    expect(result.anchorMessageIndex).toBe(7);
    expect(result.resetMicrocompactTokensFreed).toBe(true);

    expect(result.events).toHaveLength(1);
    const evt = result.events[0] as { type: string; usage: ChatCompletionUsage; model: string };
    expect(evt.type).toBe("usage");
    expect(evt.usage).toBe(usage);
    expect(evt.model).toBe("claude-3");
  });

  it("accumulates across multiple calls", () => {
    const turnUsage = emptyUsage();

    accumulateUsage({
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      turnUsage,
      model: "gpt-4",
      messagesLength: 3,
    });

    accumulateUsage({
      usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
      turnUsage,
      model: "gpt-4",
      messagesLength: 5,
    });

    expect(turnUsage.prompt_tokens).toBe(300);
    expect(turnUsage.completion_tokens).toBe(130);
    expect(turnUsage.total_tokens).toBe(430);
  });

  it("handles partial usage (no optional tokens)", () => {
    const turnUsage = emptyUsage();
    const usage: ChatCompletionUsage = {
      prompt_tokens: 50,
      completion_tokens: 25,
      total_tokens: 75,
    };

    const result = accumulateUsage({
      usage,
      turnUsage,
      model: "gpt-4",
      messagesLength: 2,
    });

    expect(turnUsage.cache_read_tokens).toBe(0);
    expect(turnUsage.cache_creation_tokens).toBe(0);
    expect(turnUsage.thinking_tokens).toBe(0);
    expect(result.lastUsage).toBe(usage);
  });
});
