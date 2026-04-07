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

describe("convertAnthropicMessages — thinking and redacted_thinking", () => {
  it("includes thinking blocks with signature for assistant messages", () => {
    const { messages } = convertAnthropicMessages(
      undefined,
      [
        {
          role: "assistant",
          content: "Answer",
          thinking_content: "Let me think...",
          thinking_signature: "sig123",
        },
      ],
    );

    const assistantContent = (messages[0] as Record<string, unknown>).content as Record<string, unknown>[];
    const thinkingBlock = assistantContent.find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.thinking).toBe("Let me think...");
    expect(thinkingBlock!.signature).toBe("sig123");
  });

  it("includes redacted_thinking blocks for assistant messages", () => {
    const { messages } = convertAnthropicMessages(
      undefined,
      [
        {
          role: "assistant",
          content: "Answer",
          redacted_thinking_data: "opaque-data",
        },
      ],
    );

    const assistantContent = (messages[0] as Record<string, unknown>).content as Record<string, unknown>[];
    const redactedBlock = assistantContent.find((b) => b.type === "redacted_thinking");
    expect(redactedBlock).toBeDefined();
    expect(redactedBlock!.data).toBe("opaque-data");
  });
});

describe("convertAnthropicMessages — isError on tool results", () => {
  it("sets is_error on tool result when isError is true", () => {
    const { messages } = convertAnthropicMessages(
      undefined,
      [
        { role: "tool", tool_call_id: "tc1", content: "Error occurred", isError: true },
      ],
    );

    const content = (messages[0] as Record<string, unknown>).content as Record<string, unknown>[];
    const toolResult = content[0];
    expect(toolResult.is_error).toBe(true);
  });

  it("does not set is_error when isError is not set", () => {
    const { messages } = convertAnthropicMessages(
      undefined,
      [
        { role: "tool", tool_call_id: "tc1", content: "ok" },
      ],
    );

    const content = (messages[0] as Record<string, unknown>).content as Record<string, unknown>[];
    const toolResult = content[0];
    expect(toolResult.is_error).toBeUndefined();
  });
});

describe("convertAnthropicMessages — cache_control skips thinking blocks", () => {
  it("places cache_control on the text block, not thinking or redacted_thinking", () => {
    const { messages } = convertAnthropicMessages(
      undefined,
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "Answer",
          thinking_content: "Thinking...",
          thinking_signature: "sig",
          redacted_thinking_data: "opaque",
        },
      ],
      { enabled: true },
    );

    const assistantContent = (messages[1] as Record<string, unknown>).content as Record<string, unknown>[];
    const thinkingBlock = assistantContent.find((b) => b.type === "thinking");
    const redactedBlock = assistantContent.find((b) => b.type === "redacted_thinking");
    const textBlock = assistantContent.find((b) => b.type === "text");

    // cache_control should be on text, not on thinking blocks
    expect(thinkingBlock!.cache_control).toBeUndefined();
    expect(redactedBlock!.cache_control).toBeUndefined();
    expect(textBlock!.cache_control).toBeDefined();
  });
});

describe("streamAnthropicChat — redacted_thinking", () => {
  it("yields redacted_thinking_data for redacted_thinking blocks", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", content_block: { type: "redacted_thinking", data: "opaque-data" } },
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

    const redactedChunk = chunks.find((c) => c.choices[0].delta.redacted_thinking_data !== undefined);
    expect(redactedChunk).toBeDefined();
  });
});

describe("streamAnthropicChat — incomplete stream detection", () => {
  it("throws ChatStreamError when stream ends without message_stop", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
      // No message_stop
    ];

    const client = makeMockClient(events);

    await expect(async () => {
      for await (const _chunk of streamAnthropicChat(client, {
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
      }, "claude-test")) {
        // consume
      }
    }).rejects.toThrow("message_stop");
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

describe("streamAnthropicChat — structured output format", () => {
  it("sends json_schema format with nested json_schema wrapper and name", async () => {
    let capturedParams: Record<string, unknown> | undefined;

    const client: AnthropicStreamClient = {
      messages: {
        stream(params: Record<string, unknown>) {
          capturedParams = params;
          return (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } };
            yield { type: "content_block_start", content_block: { type: "text" } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "{}" } };
            yield { type: "message_stop" };
          })();
        },
      },
    };

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of streamAnthropicChat(
      client,
      {
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
        outputFormat: {
          type: "json_schema",
          schema: { type: "object", properties: { name: { type: "string" } } },
          name: "my_schema",
        },
      },
      "claude-test",
    )) {
      chunks.push(chunk);
    }

    expect(capturedParams).toBeDefined();
    const outputConfig = capturedParams!.output_config as any;
    expect(outputConfig).toBeDefined();
    expect(outputConfig.format.type).toBe("json_schema");
    // Must have nested json_schema wrapper with name
    expect(outputConfig.format.json_schema).toBeDefined();
    expect(outputConfig.format.json_schema.name).toBe("my_schema");
    expect(outputConfig.format.json_schema.schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
    // Should NOT have a bare .schema at format level
    expect(outputConfig.format.schema).toBeUndefined();
  });

  it("defaults name to 'response' when not provided", async () => {
    let capturedParams: Record<string, unknown> | undefined;

    const client: AnthropicStreamClient = {
      messages: {
        stream(params: Record<string, unknown>) {
          capturedParams = params;
          return (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } };
            yield { type: "content_block_start", content_block: { type: "text" } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "{}" } };
            yield { type: "message_stop" };
          })();
        },
      },
    };

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of streamAnthropicChat(
      client,
      {
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
        outputFormat: {
          type: "json_schema",
          schema: { type: "object" },
        },
      },
      "claude-test",
    )) {
      chunks.push(chunk);
    }

    const outputConfig = capturedParams!.output_config as any;
    expect(outputConfig.format.json_schema.name).toBe("response");
  });
});

// ---------------------------------------------------------------------------
// Gap coverage: consecutive tool results merged into one user block
// ---------------------------------------------------------------------------
describe("convertAnthropicMessages — consecutive tool results", () => {
  it("merges consecutive tool messages into a single user block with multiple tool_result entries", () => {
    const { messages: result } = convertAnthropicMessages(
      undefined,
      [
        { role: "user", content: "do things" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc1", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"/a.txt"}' } },
            { id: "tc2", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"/b.txt"}' } },
          ],
        },
        { role: "tool", tool_call_id: "tc1", content: "content of a" },
        { role: "tool", tool_call_id: "tc2", content: "content of b" },
      ] as any[],
    );

    const userBlocks = result.filter((m: any) => m.role === "user");
    expect(userBlocks).toHaveLength(2);

    const toolResultUser = userBlocks[1];
    const content = toolResultUser.content as Record<string, unknown>[];
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tc1" });
    expect(content[1]).toMatchObject({ type: "tool_result", tool_use_id: "tc2" });
  });
});

// ---------------------------------------------------------------------------
// Gap coverage: malformed tool_calls JSON fallback
// ---------------------------------------------------------------------------
describe("convertAnthropicMessages — malformed tool_calls JSON", () => {
  it("falls back to empty input when tool_calls have invalid JSON arguments", () => {
    const { messages: result } = convertAnthropicMessages(
      undefined,
      [
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_bad", type: "function", function: { name: "ReadFile", arguments: "not valid json {{{" } },
          ],
        },
      ] as any[],
    );

    const assistant = result.find((m: any) => m.role === "assistant")!;
    const content = assistant.content as Record<string, unknown>[];
    const toolUse = content.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect((toolUse as any).input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Gap coverage: streamAnthropicChat sync throw from client
// ---------------------------------------------------------------------------
describe("streamAnthropicChat — sync client throw", () => {
  it("wraps a sync throw from client.messages.stream into a ChatStreamError", async () => {
    const client: AnthropicStreamClient = {
      messages: {
        stream() {
          const err = Object.assign(new Error("rate limited"), {
            status: 429,
            headers: new Map([["retry-after", "5"]]),
          });
          throw err;
        },
      },
    };

    const chunks: ChatStreamChunk[] = [];
    let caughtError: any;
    try {
      for await (const chunk of streamAnthropicChat(
        client,
        { model: "claude-test", messages: [{ role: "user", content: "hi" }] },
        "claude-test",
      )) {
        chunks.push(chunk);
      }
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError.name).toBe("ChatStreamError");
    expect(caughtError.status).toBe(429);
  });
});
