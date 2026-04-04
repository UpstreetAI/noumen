import { describe, it, expect } from "vitest";
import {
  streamAnthropicChat,
  buildAnthropicTools,
  convertAnthropicMessages,
  buildAnthropicSystemBlocks,
  contentPartsToAnthropic,
  type AnthropicStreamClient,
} from "../providers/anthropic-shared.js";
import type { ChatStreamChunk } from "../providers/types.js";

function makeMockClient(
  events: Record<string, unknown>[],
): AnthropicStreamClient {
  return {
    messages: {
      stream(_params: Record<string, unknown>) {
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
  };
}

describe("streamAnthropicChat", () => {
  it("converts a text-only response to OpenAI-shaped chunks", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
      { type: "message_delta", usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];

    const client = makeMockClient(events);
    const chunks: ChatStreamChunk[] = [];

    for await (const chunk of streamAnthropicChat(client, {
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
    }, "claude-test")) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].choices[0].delta.content).toBe("");
    expect(chunks[1].choices[0].delta.content).toBe("Hello");
    expect(chunks[2].choices[0].delta.content).toBe(" world");

    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage?.prompt_tokens).toBe(10);
    expect(last.usage?.completion_tokens).toBe(5);
  });

  it("converts tool use responses", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "tc1", name: "ReadFile", input: {} },
      },
      {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      },
      {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '"test.ts"}' },
      },
      { type: "message_stop" },
    ];

    const client = makeMockClient(events);
    const chunks: ChatStreamChunk[] = [];

    for await (const chunk of streamAnthropicChat(client, {
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
    }, "claude-test")) {
      chunks.push(chunk);
    }

    const toolStart = chunks[0];
    expect(toolStart.choices[0].delta.tool_calls?.[0].function?.name).toBe("ReadFile");

    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("tool_calls");
  });

  it("converts thinking deltas", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", content_block: { type: "thinking" } },
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Let me think..." } },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Answer" } },
      { type: "message_stop" },
    ];

    const client = makeMockClient(events);
    const chunks: ChatStreamChunk[] = [];

    for await (const chunk of streamAnthropicChat(client, {
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budgetTokens: 5000 },
    }, "claude-test")) {
      chunks.push(chunk);
    }

    const thinkingChunk = chunks.find(
      (c) => c.choices[0].delta.thinking_content === "Let me think...",
    );
    expect(thinkingChunk).toBeDefined();
  });
});

describe("buildAnthropicTools", () => {
  it("converts tool definitions to Anthropic format", () => {
    const tools = buildAnthropicTools({
      model: "test",
      messages: [],
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
    });

    expect(tools).toHaveLength(1);
    expect(tools![0].name).toBe("ReadFile");
    expect(tools![0].input_schema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  it("returns undefined when no tools", () => {
    expect(buildAnthropicTools({ model: "test", messages: [] })).toBeUndefined();
  });

  it("adds cache_control to last tool when caching enabled", () => {
    const tools = buildAnthropicTools(
      {
        model: "test",
        messages: [],
        tools: [
          {
            type: "function",
            function: {
              name: "A",
              description: "a",
              parameters: { type: "object", properties: {} },
            },
          },
          {
            type: "function",
            function: {
              name: "B",
              description: "b",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      { enabled: true },
    );

    expect((tools![0] as Record<string, unknown>).cache_control).toBeUndefined();
    expect((tools![1] as Record<string, unknown>).cache_control).toEqual({
      type: "ephemeral",
    });
  });
});

describe("convertAnthropicMessages", () => {
  it("converts user and assistant messages", () => {
    const { messages } = convertAnthropicMessages(
      undefined,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there", tool_calls: undefined },
      ],
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "hello" });
    expect((messages[1] as Record<string, unknown>).role).toBe("assistant");
  });

  it("skips system messages", () => {
    const { messages } = convertAnthropicMessages(
      "system prompt",
      [
        { role: "system", content: "ignored" },
        { role: "user", content: "hello" },
      ],
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "user", content: "hello" });
  });

  it("converts tool results to user messages", () => {
    const { messages } = convertAnthropicMessages(
      undefined,
      [
        { role: "tool", tool_call_id: "tc1", content: "result text" },
      ],
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    const content = (messages[0] as Record<string, unknown>).content as Record<string, unknown>[];
    expect(content[0].type).toBe("tool_result");
    expect(content[0].tool_use_id).toBe("tc1");
  });
});

describe("buildAnthropicSystemBlocks", () => {
  it("returns string when caching disabled", () => {
    expect(buildAnthropicSystemBlocks("Hello")).toBe("Hello");
  });

  it("returns undefined when no prompt", () => {
    expect(buildAnthropicSystemBlocks(undefined)).toBeUndefined();
  });

  it("returns array with cache_control when caching enabled", () => {
    const result = buildAnthropicSystemBlocks("Hello", { enabled: true });
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Record<string, unknown>[];
    expect(arr[0].text).toBe("Hello");
    expect(arr[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("contentPartsToAnthropic", () => {
  it("converts text parts", () => {
    const result = contentPartsToAnthropic([{ type: "text", text: "hello" }]);
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  it("converts image parts", () => {
    const result = contentPartsToAnthropic([
      { type: "image", data: "base64data", media_type: "image/png" },
    ]);
    expect(result[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "base64data" },
    });
  });

  it("converts image_url parts", () => {
    const result = contentPartsToAnthropic([
      { type: "image_url", url: "https://example.com/img.png" },
    ]);
    expect(result[0]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/img.png" },
    });
  });
});
