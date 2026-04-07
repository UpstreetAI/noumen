import { describe, it, expect } from "vitest";
import {
  streamAnthropicChat,
  processAnthropicStreamEvent,
  createAnthropicStreamState,
  mapAnthropicStopReason,
  type AnthropicStreamClient,
  type AnthropicStreamState,
} from "../providers/anthropic-shared.js";
import type { ChatStreamChunk } from "../providers/types.js";
import { ChatStreamError } from "../providers/types.js";

function makeMockClient(
  events: Record<string, unknown>[],
): AnthropicStreamClient {
  return {
    messages: {
      stream() {
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
  };
}

async function collect(client: AnthropicStreamClient): Promise<ChatStreamChunk[]> {
  const chunks: ChatStreamChunk[] = [];
  for await (const chunk of streamAnthropicChat(client, {
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
  }, "claude-test")) {
    chunks.push(chunk);
  }
  return chunks;
}

function processEvent(ev: Record<string, unknown>, state?: AnthropicStreamState): ChatStreamChunk[] {
  return processAnthropicStreamEvent(ev, state ?? createAnthropicStreamState(), "test-model");
}

// ---------------------------------------------------------------------------
// 1A: Missing delta on content_block_delta
// ---------------------------------------------------------------------------
describe("1A: content_block_delta with missing delta", () => {
  it("returns empty chunks instead of throwing", () => {
    const state = createAnthropicStreamState();
    const chunks = processEvent({ type: "content_block_delta", delta: undefined, index: 0 }, state);
    expect(chunks).toHaveLength(0);
  });

  it("returns empty chunks when delta is null", () => {
    const state = createAnthropicStreamState();
    const chunks = processEvent({ type: "content_block_delta", delta: null, index: 0 }, state);
    expect(chunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 1B: Missing partial_json on input_json_delta
// ---------------------------------------------------------------------------
describe("1B: input_json_delta with missing partial_json", () => {
  it("skips chunk when partial_json is undefined", () => {
    const state = createAnthropicStreamState();
    // Register a tool first
    processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tc1", name: "ReadFile", input: {} },
    }, state);

    const chunks = processEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta" },
    }, state);
    expect(chunks).toHaveLength(0);
  });

  it("skips chunk when partial_json is empty string", () => {
    const state = createAnthropicStreamState();
    processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tc1", name: "ReadFile", input: {} },
    }, state);

    const chunks = processEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "" },
    }, state);
    expect(chunks).toHaveLength(0);
  });

  it("emits chunk for valid partial_json", () => {
    const state = createAnthropicStreamState();
    processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tc1", name: "ReadFile", input: {} },
    }, state);

    const chunks = processEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    }, state);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.tool_calls?.[0].function?.arguments).toBe('{"path":');
  });
});

// ---------------------------------------------------------------------------
// 1C: tool_use without id or name
// ---------------------------------------------------------------------------
describe("1C: tool_use content_block_start with missing id/name", () => {
  it("skips when id is missing", () => {
    const state = createAnthropicStreamState();
    const chunks = processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", name: "ReadFile", input: {} },
    }, state);
    expect(chunks).toHaveLength(0);
    expect(state.nextToolIndex).toBe(0);
  });

  it("skips when name is missing", () => {
    const state = createAnthropicStreamState();
    const chunks = processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tc1", input: {} },
    }, state);
    expect(chunks).toHaveLength(0);
    expect(state.nextToolIndex).toBe(0);
  });

  it("skips when both id and name are missing", () => {
    const state = createAnthropicStreamState();
    const chunks = processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", input: {} },
    }, state);
    expect(chunks).toHaveLength(0);
  });

  it("emits when both id and name are present", () => {
    const state = createAnthropicStreamState();
    const chunks = processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tc1", name: "ReadFile", input: {} },
    }, state);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.tool_calls?.[0].id).toBe("tc1");
    expect(chunks[0].choices[0].delta.tool_calls?.[0].function?.name).toBe("ReadFile");
  });
});

// ---------------------------------------------------------------------------
// 1D: usage zero-overwrite on message_delta
// ---------------------------------------------------------------------------
describe("1D: message_delta does not zero-overwrite usage from message_start", () => {
  it("preserves output_tokens when message_delta sends 0", () => {
    const state = createAnthropicStreamState();
    processEvent({
      type: "message_start",
      message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } },
    }, state);

    expect(state.outputTokens).toBe(5);

    processEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 0 },
    }, state);

    expect(state.outputTokens).toBe(5);
  });

  it("updates output_tokens when message_delta sends positive value", () => {
    const state = createAnthropicStreamState();
    processEvent({
      type: "message_start",
      message: { usage: { input_tokens: 10, output_tokens: 5 } },
    }, state);

    processEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 42 },
    }, state);

    expect(state.outputTokens).toBe(42);
  });

  it("preserves thinking_tokens when message_delta sends 0", () => {
    const state = createAnthropicStreamState();
    processEvent({
      type: "message_start",
      message: { usage: { input_tokens: 10, output_tokens: 0, thinking_tokens: 100 } },
    }, state);

    expect(state.thinkingTokens).toBe(100);

    processEvent({
      type: "message_delta",
      delta: {},
      usage: { thinking_tokens: 0, output_tokens: 20 },
    }, state);

    expect(state.thinkingTokens).toBe(100);
    expect(state.outputTokens).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// 1E: SDK mutation of content_block
// ---------------------------------------------------------------------------
describe("1E: content_block_start is not affected by SDK-side mutation", () => {
  it("shallow-copies the content_block object", () => {
    const state = createAnthropicStreamState();
    const block = { type: "text", text: "original" };
    processEvent({
      type: "content_block_start",
      index: 0,
      content_block: block,
    }, state);

    // Mutate the original — should not affect state
    block.type = "mutated";
    expect(state.blockIndexToType.get(0)).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// 1F: empty stream
// ---------------------------------------------------------------------------
describe("1F: empty stream throws", () => {
  it("throws ChatStreamError for empty stream (no events)", async () => {
    const client = makeMockClient([]);
    await expect(collect(client)).rejects.toThrow(ChatStreamError);
    await expect(collect(client)).rejects.toThrow("Stream returned no events");
  });

  it("throws for stream with events but no message_stop", async () => {
    const client = makeMockClient([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
    ]);
    await expect(collect(client)).rejects.toThrow("Stream ended without receiving message_stop event");
  });
});

// ---------------------------------------------------------------------------
// Duplicate text in start + delta
// ---------------------------------------------------------------------------
describe("content_block_start text field is ignored (empty string emitted)", () => {
  it("emits empty content on block start, real content on delta", () => {
    const state = createAnthropicStreamState();

    const startChunks = processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "Hello" },
    }, state);
    expect(startChunks).toHaveLength(1);
    expect(startChunks[0].choices[0].delta.content).toBe("");

    const deltaChunks = processEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    }, state);
    expect(deltaChunks).toHaveLength(1);
    expect(deltaChunks[0].choices[0].delta.content).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// Multi-tool with missing block indices on delta
// ---------------------------------------------------------------------------
describe("multi-tool: input_json_delta with missing blockIndex", () => {
  it("falls back to last registered tool when blockIndex is missing", () => {
    const state = createAnthropicStreamState();

    processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tc1", name: "ReadFile", input: {} },
    }, state);
    processEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tc2", name: "WriteFile", input: {} },
    }, state);

    // Delta without index — should go to tc2 (last registered)
    const chunks = processEvent({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"data":' },
    }, state);

    expect(chunks).toHaveLength(1);
    const tc = chunks[0].choices[0].delta.tool_calls?.[0];
    expect(tc?.index).toBe(1);
  });

  it("routes to correct tool when blockIndex is present", () => {
    const state = createAnthropicStreamState();

    processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tc1", name: "ReadFile", input: {} },
    }, state);
    processEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tc2", name: "WriteFile", input: {} },
    }, state);

    const chunks = processEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    }, state);

    expect(chunks).toHaveLength(1);
    const tc = chunks[0].choices[0].delta.tool_calls?.[0];
    expect(tc?.index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full thinking flow with signature
// ---------------------------------------------------------------------------
describe("interleaved thinking + signature + text", () => {
  it("processes full thinking flow end-to-end", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0, thinking_tokens: 50 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think..." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_abc" } },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Here is the answer" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ];

    const chunks = await collect(makeMockClient(events));

    const thinkingChunks = chunks.filter(c => c.choices[0]?.delta.thinking_content !== undefined);
    expect(thinkingChunks.length).toBeGreaterThanOrEqual(1);
    expect(thinkingChunks.some(c => c.choices[0].delta.thinking_content === "Let me think...")).toBe(true);

    const sigChunks = chunks.filter(c => c.choices[0]?.delta.thinking_signature !== undefined);
    expect(sigChunks.length).toBeGreaterThanOrEqual(1);

    const textChunks = chunks.filter(c =>
      c.choices[0]?.delta.content !== undefined && c.choices[0].delta.content !== "",
    );
    expect(textChunks.some(c => c.choices[0].delta.content === "Here is the answer")).toBe(true);

    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage?.prompt_tokens).toBe(10);
    expect(last.usage?.completion_tokens).toBe(20);
    expect(last.usage?.thinking_tokens).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// message_delta without stop_reason
// ---------------------------------------------------------------------------
describe("message_delta without stop_reason uses fallback", () => {
  it("falls back to 'stop' when no stop_reason on message_delta and no tools", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", delta: {}, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const chunks = await collect(makeMockClient(events));
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
  });

  it("falls back to 'tool_calls' when no stop_reason but tools present", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tc1", name: "ReadFile", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"x"}' },
      },
      { type: "message_delta", delta: {}, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    const chunks = await collect(makeMockClient(events));
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("tool_calls");
  });
});

// ---------------------------------------------------------------------------
// mapAnthropicStopReason edge cases
// ---------------------------------------------------------------------------
describe("mapAnthropicStopReason", () => {
  it("maps all known stop reasons correctly", () => {
    expect(mapAnthropicStopReason("end_turn", false)).toBe("stop");
    expect(mapAnthropicStopReason("tool_use", false)).toBe("tool_calls");
    expect(mapAnthropicStopReason("max_tokens", false)).toBe("length");
    expect(mapAnthropicStopReason("model_context_window_exceeded", false)).toBe("length");
    expect(mapAnthropicStopReason("stop_sequence", false)).toBe("stop");
    expect(mapAnthropicStopReason("refusal", false)).toBe("content_filter");
  });

  it("falls back for undefined stop_reason", () => {
    expect(mapAnthropicStopReason(undefined, false)).toBe("stop");
    expect(mapAnthropicStopReason(undefined, true)).toBe("tool_calls");
  });

  it("falls back for unknown stop_reason", () => {
    expect(mapAnthropicStopReason("something_new", false)).toBe("stop");
    expect(mapAnthropicStopReason("something_new", true)).toBe("tool_calls");
  });
});

// ---------------------------------------------------------------------------
// Unknown event types are silently ignored
// ---------------------------------------------------------------------------
describe("unknown event types", () => {
  it("returns empty chunks for unrecognized event types", () => {
    const state = createAnthropicStreamState();
    const chunks = processEvent({ type: "content_block_stop", index: 0 }, state);
    expect(chunks).toHaveLength(0);
  });

  it("returns empty chunks for completely unknown types", () => {
    const state = createAnthropicStreamState();
    const chunks = processEvent({ type: "ping" }, state);
    expect(chunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// redacted_thinking block
// ---------------------------------------------------------------------------
describe("redacted_thinking", () => {
  it("processes redacted_thinking on content_block_start", () => {
    const state = createAnthropicStreamState();
    const chunks = processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: "encrypted_data_blob" },
    }, state);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.redacted_thinking_data).toBe("encrypted_data_blob");
  });

  it("handles missing data field on redacted_thinking", () => {
    const state = createAnthropicStreamState();
    const chunks = processEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking" },
    }, state);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.redacted_thinking_data).toBe("");
  });
});
