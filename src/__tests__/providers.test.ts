import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatStreamChunk } from "../providers/types.js";

describe("OpenAIProvider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("maps streaming chunks correctly", async () => {
    const mockChunks = [
      {
        id: "c1",
        model: "gpt-4o",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null },
        ],
      },
      {
        id: "c2",
        model: "gpt-4o",
        choices: [
          { index: 0, delta: { content: " world" }, finish_reason: null },
        ],
      },
      {
        id: "c3",
        model: "gpt-4o",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop" },
        ],
      },
    ];

    const mockCreate = vi.fn().mockResolvedValue(
      (async function* () {
        for (const chunk of mockChunks) yield chunk;
      })(),
    );

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: mockCreate } };
      },
    }));

    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta.content).toBe("Hello");
    expect(chunks[1].choices[0].delta.content).toBe(" world");
    expect(chunks[2].choices[0].finish_reason).toBe("stop");
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it("includes system message when provided", async () => {
    const mockCreate = vi.fn().mockResolvedValue(
      (async function* () {
        yield {
          id: "c1",
          model: "gpt-4o",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
      })(),
    );

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: mockCreate } };
      },
    }));

    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    for await (const _ of provider.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      system: "You are helpful.",
    })) {
      // consume
    }

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    });
  });
});

describe("AnthropicProvider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("maps Anthropic stream events to OpenAI-shaped chunks", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      { type: "message_stop" },
    ];

    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          stream: () =>
            (async function* () {
              for (const event of events) yield event;
            })(),
        };
      },
    }));

    const { AnthropicProvider } = await import("../providers/anthropic.js");
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const textParts = chunks
      .map((c) => c.choices[0]?.delta?.content)
      .filter(Boolean);
    expect(textParts).toContain("Hello");
    expect(textParts).toContain(" world");

    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
  });

  it("maps tool_use blocks with finish_reason tool_calls", async () => {
    const events = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tc_1", name: "ReadFile", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'path":"a.ts"}' },
      },
      { type: "message_stop" },
    ];

    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          stream: () =>
            (async function* () {
              for (const event of events) yield event;
            })(),
        };
      },
    }));

    const { AnthropicProvider } = await import("../providers/anthropic.js");
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "read a.ts" }],
    })) {
      chunks.push(chunk);
    }

    // Find the chunk that starts the tool call
    const startChunk = chunks.find(
      (c) => c.choices[0]?.delta?.tool_calls?.[0]?.id === "tc_1",
    );
    expect(startChunk).toBeDefined();
    expect(startChunk!.choices[0].delta.tool_calls![0].function?.name).toBe("ReadFile");

    // Last chunk should have finish_reason "tool_calls"
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("tool_calls");
  });
});
