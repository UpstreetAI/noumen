import { describe, it, expect } from "vitest";
import { translateStream, type AiSdkStreamPart } from "../providers/ai-sdk/stream.js";
import type { ChatStreamChunk } from "../providers/types.js";
import { ChatStreamError } from "../providers/types.js";

async function drain(parts: AiSdkStreamPart[], model = "gpt-5"): Promise<ChatStreamChunk[]> {
  const stream = new ReadableStream<AiSdkStreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
  const out: ChatStreamChunk[] = [];
  for await (const c of translateStream(stream, model)) out.push(c);
  return out;
}

describe("translateStream — text", () => {
  it("passes text deltas through as .delta.content", async () => {
    const chunks = await drain([
      { type: "stream-start" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "a" },
      { type: "text-delta", id: "t", delta: "b" },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ]);
    expect(chunks.map((c) => c.choices[0].delta.content).filter(Boolean)).toEqual(["a", "b"]);
  });

  it("drops empty text deltas", async () => {
    const chunks = await drain([
      { type: "text-delta", id: "t", delta: "" },
      { type: "text-delta", id: "t", delta: "real" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const text = chunks.map((c) => c.choices[0].delta.content).filter(Boolean);
    expect(text).toEqual(["real"]);
  });
});

describe("translateStream — reasoning", () => {
  it("passes reasoning deltas through as .delta.thinking_content", async () => {
    const chunks = await drain([
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "plan step 1" },
      { type: "reasoning-delta", id: "r", delta: " plan step 2" },
      {
        type: "reasoning-end",
        id: "r",
        providerMetadata: {
          anthropic: { signature: "sig-xyz" },
        },
      },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    const thinking = chunks
      .map((c) => c.choices[0].delta.thinking_content)
      .filter(Boolean);
    expect(thinking).toEqual(["plan step 1", " plan step 2"]);

    const sig = chunks.find((c) => c.choices[0].delta.thinking_signature);
    expect(sig?.choices[0].delta.thinking_signature).toBe("sig-xyz");
  });

  it("surfaces redacted thinking on reasoning-end", async () => {
    const chunks = await drain([
      { type: "reasoning-start", id: "r" },
      {
        type: "reasoning-end",
        id: "r",
        providerMetadata: {
          anthropic: { redactedData: "OPAQUE-BLOB" },
        },
      },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const r = chunks.find((c) => c.choices[0].delta.redacted_thinking_data);
    expect(r?.choices[0].delta.redacted_thinking_data).toBe("OPAQUE-BLOB");
  });
});

describe("translateStream — tool calls", () => {
  it("streams tool-input deltas through OpenAI-shaped tool_calls[].function.arguments", async () => {
    const chunks = await drain([
      { type: "tool-input-start", id: "call_1", toolName: "Search" },
      { type: "tool-input-delta", id: "call_1", delta: '{"qu' },
      { type: "tool-input-delta", id: "call_1", delta: 'ery":"' },
      { type: "tool-input-delta", id: "call_1", delta: 'hi"}' },
      { type: "tool-input-end", id: "call_1" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Search",
        input: '{"query":"hi"}',
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    const toolDeltas = chunks.flatMap(
      (c) => c.choices[0].delta.tool_calls ?? [],
    );

    expect(toolDeltas[0]).toMatchObject({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "Search", arguments: "" },
    });

    const argDeltas = toolDeltas
      .slice(1)
      .map((t) => t.function?.arguments)
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    expect(argDeltas.join("")).toBe('{"query":"hi"}');
  });

  it("emits a single tool-call chunk when there was no preceding tool-input-start", async () => {
    const chunks = await drain([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Search",
        input: '{"query":"hi"}',
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    const toolCall = chunks
      .flatMap((c) => c.choices[0].delta.tool_calls ?? [])
      .find((t) => t.id === "call_1");
    expect(toolCall).toMatchObject({
      id: "call_1",
      type: "function",
      function: { name: "Search", arguments: '{"query":"hi"}' },
    });
  });

  it("applies JSON repair to salvageable tool-call input when no streaming deltas ran", async () => {
    const chunks = await drain([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Search",
        // Missing quotes around the property name.
        input: "{query:'hi'}",
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const tc = chunks
      .flatMap((c) => c.choices[0].delta.tool_calls ?? [])
      .find((t) => t.id === "call_1")!;
    // Repaired to valid JSON.
    expect(() => JSON.parse(tc.function!.arguments ?? "")).not.toThrow();
    expect(JSON.parse(tc.function!.arguments ?? "")).toEqual({ query: "hi" });
  });
});

describe("translateStream — finish + usage", () => {
  it("flat v2 usage maps onto prompt/completion/total", async () => {
    const chunks = await drain([
      { type: "text-delta", id: "t", delta: "x" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
    ]);
    const last = chunks[chunks.length - 1];
    expect(last.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
      thinking_tokens: undefined,
    });
  });

  it("nested v3 usage maps totals, reasoning, and cache tokens", async () => {
    const chunks = await drain([
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: { total: 100, cacheRead: 40, cacheWrite: 10 },
          outputTokens: { total: 50, reasoning: 15 },
        },
      },
    ]);
    expect(chunks[chunks.length - 1].usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 40,
      cache_creation_tokens: 10,
      thinking_tokens: 15,
    });
  });

  it("lifts anthropic cache tokens from providerMetadata when usage is flat", async () => {
    const chunks = await drain([
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
        providerMetadata: {
          anthropic: {
            cacheReadInputTokens: 123,
            cacheCreationInputTokens: 9,
          },
        },
      },
    ]);
    expect(chunks[chunks.length - 1].usage).toMatchObject({
      cache_read_tokens: 123,
      cache_creation_tokens: 9,
    });
  });

  it("maps finishReason 'stop' with tool calls seen to 'tool_calls'", async () => {
    const chunks = await drain([
      { type: "tool-input-start", id: "c1", toolName: "T" },
      { type: "tool-input-delta", id: "c1", delta: "{}" },
      { type: "tool-input-end", id: "c1" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls");
  });

  it("maps finishReason 'length' through", async () => {
    const chunks = await drain([
      { type: "text-delta", id: "t", delta: "x" },
      {
        type: "finish",
        finishReason: "length",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("length");
  });

  it("accepts structured finish reason objects ({ unified, raw })", async () => {
    const chunks = await drain([
      {
        type: "finish",
        finishReason: { unified: "content-filter", raw: "safety" },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("content_filter");
  });
});

describe("translateStream — errors", () => {
  it("throws ChatStreamError with status when stream emits an error part", async () => {
    const stream = new ReadableStream<AiSdkStreamPart>({
      start(controller) {
        const apiErr = Object.assign(new Error("503 unavailable"), {
          name: "AI_APICallError",
          statusCode: 503,
          responseHeaders: { "retry-after": "30" },
        });
        controller.enqueue({ type: "error", error: apiErr });
        controller.close();
      },
    });

    let caught: unknown;
    try {
      for await (const _ of translateStream(stream, "gpt-5")) {
        /* no-op */
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChatStreamError);
    expect((caught as ChatStreamError).status).toBe(503);
    expect((caught as ChatStreamError).retryAfter).toBe("30");
  });

  it("wraps plain Error into ChatStreamError with no status", async () => {
    const stream = new ReadableStream<AiSdkStreamPart>({
      start(controller) {
        controller.enqueue({ type: "error", error: new Error("random boom") });
        controller.close();
      },
    });

    let caught: unknown;
    try {
      for await (const _ of translateStream(stream, "gpt-5")) {
        /* no-op */
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChatStreamError);
    expect((caught as ChatStreamError).message).toBe("random boom");
    expect((caught as ChatStreamError).status).toBeUndefined();
  });
});
