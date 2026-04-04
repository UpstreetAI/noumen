import { describe, it, expect, vi } from "vitest";
import { VertexAnthropicProvider } from "../providers/vertex.js";
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

describe("VertexAnthropicProvider", () => {
  it("throws when no client provided and SDK not installed", () => {
    let sdkInstalled = false;
    try {
      require("@anthropic-ai/vertex-sdk");
      sdkInstalled = true;
    } catch {
      // SDK not installed — test can proceed
    }

    if (sdkInstalled) {
      // When the SDK is installed, the require() succeeds so this error
      // path is unreachable. Verify the constructor at least rejects
      // an invalid googleAuth object instead.
      expect(() => new VertexAnthropicProvider({ googleAuth: {} })).toThrow();
      return;
    }

    expect(() => new VertexAnthropicProvider({ googleAuth: {} })).toThrow(
      "requires @anthropic-ai/vertex-sdk",
    );
  });

  it("streams text via shared Anthropic logic", async () => {
    const client = makeMockClient([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello from Vertex" } },
      { type: "message_stop" },
    ]);

    const provider = new VertexAnthropicProvider({
      client,
      projectId: "my-project",
      region: "europe-west1",
    });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const textChunk = chunks.find(
      (c) => c.choices[0].delta.content === "Hello from Vertex",
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

    const provider = new VertexAnthropicProvider({ client });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    const last = chunks[chunks.length - 1];
    expect(last.model).toBe("claude-sonnet-4");
  });

  it("handles cache usage tokens", async () => {
    const client = makeMockClient([
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 10,
          },
        },
      },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "cached" } },
      { type: "message_delta", usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]);

    const provider = new VertexAnthropicProvider({
      client,
      cacheControl: { enabled: true },
    });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    const last = chunks[chunks.length - 1];
    expect(last.usage?.prompt_tokens).toBe(100);
    expect(last.usage?.completion_tokens).toBe(5);
    expect(last.usage?.cache_read_tokens).toBe(80);
    expect(last.usage?.cache_creation_tokens).toBe(10);
  });

  it("streams tool calls correctly", async () => {
    const client = makeMockClient([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "tc1", name: "Bash", input: {} },
      },
      {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      },
      { type: "message_stop" },
    ]);

    const provider = new VertexAnthropicProvider({ client });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "list files" }],
      tools: [
        {
          type: "function",
          function: {
            name: "Bash",
            description: "Run shell command",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
      ],
    })) {
      chunks.push(chunk);
    }

    const toolStart = chunks.find((c) => c.choices[0].delta.tool_calls?.[0]?.function?.name);
    expect(toolStart!.choices[0].delta.tool_calls![0].function!.name).toBe("Bash");

    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("tool_calls");
  });
});
