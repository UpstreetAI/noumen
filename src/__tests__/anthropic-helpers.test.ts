import { describe, it, expect } from "vitest";
import {
  buildAnthropicRequestParams,
  mapAnthropicStopReason,
  createAnthropicStreamState,
  processAnthropicStreamEvent,
} from "../providers/anthropic-shared.js";
import type { ChatParams } from "../providers/types.js";

function baseChatParams(overrides?: Partial<ChatParams>): ChatParams {
  return {
    model: "claude-3-haiku",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildAnthropicRequestParams
// ---------------------------------------------------------------------------

describe("buildAnthropicRequestParams", () => {
  it("uses default model when params.model is not set", () => {
    const { model, streamParams } = buildAnthropicRequestParams(
      baseChatParams(),
      "claude-3-haiku",
    );
    expect(model).toBe("claude-3-haiku");
    expect(streamParams.model).toBe("claude-3-haiku");
  });

  it("overrides model from params", () => {
    const { model } = buildAnthropicRequestParams(
      baseChatParams({ model: "claude-3-opus" }),
      "claude-3-haiku",
    );
    expect(model).toBe("claude-3-opus");
  });

  it("defaults max_tokens to 8192 without thinking", () => {
    const { streamParams } = buildAnthropicRequestParams(baseChatParams(), "claude-3-haiku");
    expect(streamParams.max_tokens).toBe(8192);
  });

  it("respects explicit max_tokens without thinking", () => {
    const { streamParams } = buildAnthropicRequestParams(
      baseChatParams({ max_tokens: 4096 }),
      "claude-3-haiku",
    );
    expect(streamParams.max_tokens).toBe(4096);
  });

  it("includes temperature when thinking is disabled", () => {
    const { streamParams } = buildAnthropicRequestParams(
      baseChatParams({ temperature: 0.5 }),
      "claude-3-haiku",
    );
    expect(streamParams.temperature).toBe(0.5);
  });

  it("omits temperature when thinking is enabled", () => {
    const { streamParams } = buildAnthropicRequestParams(
      baseChatParams({
        thinking: { type: "enabled", budgetTokens: 1000 },
        max_tokens: 8192,
      }),
      "claude-3-haiku",
    );
    expect(streamParams.temperature).toBeUndefined();
  });

  it("adds thinking config when enabled", () => {
    const { streamParams } = buildAnthropicRequestParams(
      baseChatParams({
        thinking: { type: "enabled", budgetTokens: 1000 },
        max_tokens: 8192,
      }),
      "claude-3-haiku",
    );
    expect(streamParams.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1000,
    });
  });

  it("clamps thinking budget to max_tokens - 1", () => {
    const { streamParams } = buildAnthropicRequestParams(
      baseChatParams({
        thinking: { type: "enabled", budgetTokens: 50000 },
        max_tokens: 4096,
      }),
      "claude-3-haiku",
    );
    const thinking = streamParams.thinking as { budget_tokens: number };
    expect(thinking.budget_tokens).toBe(4095);
  });

  it("adds json_schema output config with betas", () => {
    const { streamParams } = buildAnthropicRequestParams(
      baseChatParams({
        outputFormat: {
          type: "json_schema",
          schema: { type: "object", properties: {} },
          name: "mySchema",
        },
      }),
      "claude-3-haiku",
    );
    expect(streamParams.output_config).toBeDefined();
    const config = streamParams.output_config as Record<string, unknown>;
    const format = config.format as Record<string, unknown>;
    expect(format.type).toBe("json_schema");
    expect(streamParams.betas).toContain("structured-outputs-2025-12-15");
  });

  it("appends json_object hint to string system prompt", () => {
    const { streamParams } = buildAnthropicRequestParams(
      baseChatParams({
        system: "You are helpful.",
        outputFormat: { type: "json_object" },
      }),
      "claude-3-haiku",
    );
    expect(typeof streamParams.system).toBe("string");
    expect(streamParams.system as string).toContain("valid JSON only");
  });

  it("appends json_object hint to array system prompt", () => {
    const { streamParams } = buildAnthropicRequestParams(
      baseChatParams({
        system: "You are helpful.",
        outputFormat: { type: "json_object" },
      }),
      "claude-3-haiku",
      { enabled: true },
    );
    expect(Array.isArray(streamParams.system)).toBe(true);
    const blocks = streamParams.system as Array<Record<string, unknown>>;
    expect(blocks[0].text as string).toContain("valid JSON only");
  });

  it("sets json_object hint as system when no system prompt", () => {
    const { streamParams } = buildAnthropicRequestParams(
      baseChatParams({
        outputFormat: { type: "json_object" },
      }),
      "claude-3-haiku",
    );
    expect(typeof streamParams.system).toBe("string");
    expect(streamParams.system as string).toContain("valid JSON only");
  });
});

// ---------------------------------------------------------------------------
// mapAnthropicStopReason
// ---------------------------------------------------------------------------

describe("mapAnthropicStopReason", () => {
  const cases: Array<[string | undefined, boolean, string]> = [
    ["end_turn", false, "stop"],
    ["tool_use", false, "tool_calls"],
    ["max_tokens", false, "length"],
    ["model_context_window_exceeded", false, "length"],
    ["stop_sequence", false, "stop"],
    ["refusal", false, "content_filter"],
    [undefined, false, "stop"],
    [undefined, true, "tool_calls"],
    ["unknown_reason", false, "stop"],
    ["unknown_reason", true, "tool_calls"],
  ];

  for (const [stopReason, hasToolCalls, expected] of cases) {
    it(`maps ${String(stopReason)} (tools=${hasToolCalls}) -> ${expected}`, () => {
      expect(mapAnthropicStopReason(stopReason, hasToolCalls)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// processAnthropicStreamEvent
// ---------------------------------------------------------------------------

describe("processAnthropicStreamEvent", () => {
  const MODEL = "claude-3-haiku";

  it("handles message_start with usage", () => {
    const state = createAnthropicStreamState();
    const chunks = processAnthropicStreamEvent({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 10,
        },
      },
    }, state, MODEL);

    expect(chunks).toHaveLength(0);
    expect(state.inputTokens).toBe(100);
    expect(state.cacheReadTokens).toBe(50);
    expect(state.cacheCreationTokens).toBe(10);
  });

  it("handles message_delta with stop_reason and output tokens", () => {
    const state = createAnthropicStreamState();
    const chunks = processAnthropicStreamEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 42 },
    }, state, MODEL);

    expect(chunks).toHaveLength(0);
    expect(state.stopReason).toBe("end_turn");
    expect(state.outputTokens).toBe(42);
  });

  it("handles content_block_start for text", () => {
    const state = createAnthropicStreamState();
    const chunks = processAnthropicStreamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    }, state, MODEL);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe("");
    expect(state.blockIndexToType.get(0)).toBe("text");
  });

  it("handles content_block_start for thinking", () => {
    const state = createAnthropicStreamState();
    const chunks = processAnthropicStreamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    }, state, MODEL);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.thinking_content).toBe("");
  });

  it("handles content_block_start for redacted_thinking", () => {
    const state = createAnthropicStreamState();
    const chunks = processAnthropicStreamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: "abc123" },
    }, state, MODEL);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.redacted_thinking_data).toBe("abc123");
  });

  it("handles content_block_start for tool_use", () => {
    const state = createAnthropicStreamState();
    const chunks = processAnthropicStreamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tc_1", name: "ReadFile", input: {} },
    }, state, MODEL);

    expect(chunks).toHaveLength(1);
    const toolCalls = chunks[0].choices[0].delta.tool_calls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls![0].id).toBe("tc_1");
    expect(toolCalls![0].function!.name).toBe("ReadFile");
    expect(state.toolIndexMap.get("tc_1")).toBe(0);
  });

  it("handles content_block_delta for text_delta", () => {
    const state = createAnthropicStreamState();
    const chunks = processAnthropicStreamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    }, state, MODEL);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe("Hello");
  });

  it("handles content_block_delta for thinking_delta", () => {
    const state = createAnthropicStreamState();
    const chunks = processAnthropicStreamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Let me think..." },
    }, state, MODEL);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.thinking_content).toBe("Let me think...");
  });

  it("handles content_block_delta for signature_delta on thinking block", () => {
    const state = createAnthropicStreamState();
    state.blockIndexToType.set(0, "thinking");
    const chunks = processAnthropicStreamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig123" },
    }, state, MODEL);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.thinking_signature).toBe("sig123");
  });

  it("ignores signature_delta on non-thinking blocks", () => {
    const state = createAnthropicStreamState();
    state.blockIndexToType.set(0, "text");
    const chunks = processAnthropicStreamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig123" },
    }, state, MODEL);

    expect(chunks).toHaveLength(0);
  });

  it("handles content_block_delta for input_json_delta", () => {
    const state = createAnthropicStreamState();
    state.toolIndexMap.set("tc_1", 0);
    state.blockIndexToToolId.set(1, "tc_1");

    const chunks = processAnthropicStreamEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    }, state, MODEL);

    expect(chunks).toHaveLength(1);
    const toolCalls = chunks[0].choices[0].delta.tool_calls;
    expect(toolCalls![0].function!.arguments).toBe('{"path":');
  });

  it("handles message_stop with usage", () => {
    const state = createAnthropicStreamState();
    state.inputTokens = 100;
    state.outputTokens = 50;
    state.stopReason = "end_turn";

    const chunks = processAnthropicStreamEvent({
      type: "message_stop",
    }, state, MODEL);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].finish_reason).toBe("stop");
    expect(chunks[0].usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
      thinking_tokens: undefined,
    });
    expect(state.receivedMessageStop).toBe(true);
  });

  it("handles message_stop with tool_use stop reason", () => {
    const state = createAnthropicStreamState();
    state.stopReason = "tool_use";
    state.toolIndexMap.set("tc_1", 0);

    const chunks = processAnthropicStreamEvent({
      type: "message_stop",
    }, state, MODEL);

    expect(chunks[0].choices[0].finish_reason).toBe("tool_calls");
  });

  it("returns empty for unknown event types", () => {
    const state = createAnthropicStreamState();
    const chunks = processAnthropicStreamEvent({
      type: "unknown_event",
    }, state, MODEL);
    expect(chunks).toHaveLength(0);
  });

  it("increments chunkIndex across multiple events", () => {
    const state = createAnthropicStreamState();
    processAnthropicStreamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    }, state, MODEL);

    const chunks2 = processAnthropicStreamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi" },
    }, state, MODEL);

    expect(chunks2[0].id).toBe("chatcmpl-1");
    expect(state.chunkIndex).toBe(2);
  });
});
