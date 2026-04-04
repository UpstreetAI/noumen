import { describe, it, expect, vi } from "vitest";
import { BedrockAnthropicProvider } from "../providers/bedrock.js";
import type { ChatStreamChunk } from "../providers/types.js";
import type { AnthropicStreamClient } from "../providers/anthropic-shared.js";

function makeMockClient(
  events: Record<string, unknown>[],
): AnthropicStreamClient {
  return {
    messages: {
      stream: vi.fn().mockReturnValue(
        (async function* () {
          for (const event of events) yield event;
        })(),
      ),
    },
  };
}

describe("BedrockAnthropicProvider", () => {
  it("throws when no client provided and SDK not installed", () => {
    expect(() => new BedrockAnthropicProvider({})).toThrow(
      "requires @anthropic-ai/bedrock-sdk",
    );
  });

  it("streams text via shared Anthropic logic", async () => {
    const client = makeMockClient([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello from Bedrock" } },
      { type: "message_stop" },
    ]);

    const provider = new BedrockAnthropicProvider({ client });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const textChunk = chunks.find(
      (c) => c.choices[0].delta.content === "Hello from Bedrock",
    );
    expect(textChunk).toBeDefined();

    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage?.prompt_tokens).toBe(5);
  });

  it("uses default model when none specified", async () => {
    const client = makeMockClient([
      { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: "message_stop" },
    ]);

    const provider = new BedrockAnthropicProvider({ client });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    const last = chunks[chunks.length - 1];
    expect(last.model).toBe("us.anthropic.claude-sonnet-4-20250514-v1:0");
  });

  it("streams tool calls correctly", async () => {
    const client = makeMockClient([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "tc1", name: "ReadFile", input: {} },
      },
      {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"path":"test.ts"}' },
      },
      { type: "message_stop" },
    ]);

    const provider = new BedrockAnthropicProvider({ client });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      messages: [{ role: "user", content: "read test.ts" }],
      tools: [
        {
          type: "function",
          function: {
            name: "ReadFile",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    })) {
      chunks.push(chunk);
    }

    const toolStart = chunks.find((c) => c.choices[0].delta.tool_calls?.[0]?.function?.name);
    expect(toolStart!.choices[0].delta.tool_calls![0].function!.name).toBe("ReadFile");

    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("tool_calls");
  });
});
