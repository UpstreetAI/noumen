import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatStreamChunk } from "../providers/types.js";
import type { ChatMessage } from "../session/types.js";

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

  it("populates usage from message_start and message_delta", async () => {
    const events = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 100, output_tokens: 1 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "message_delta", usage: { output_tokens: 25 } },
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

    const last = chunks[chunks.length - 1];
    expect(last.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
    });
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

describe("GeminiProvider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("maps streaming text chunks to OpenAI-shaped format", async () => {
    const streamChunks = [
      {
        candidates: [
          {
            content: { parts: [{ text: "Hello" }] },
            finishReason: undefined,
          },
        ],
      },
      {
        candidates: [
          {
            content: { parts: [{ text: " world" }] },
            finishReason: "STOP",
          },
        ],
      },
    ];

    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: vi.fn().mockResolvedValue(
            (async function* () {
              for (const chunk of streamChunks) yield chunk;
            })(),
          ),
        };
      },
    }));

    const { GeminiProvider } = await import("../providers/gemini.js");
    const provider = new GeminiProvider({ apiKey: "test-key" });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const textParts = chunks
      .map((c) => c.choices[0]?.delta?.content)
      .filter(Boolean);
    expect(textParts).toContain("Hello");
    expect(textParts).toContain(" world");

    const stopChunk = chunks.find((c) => c.choices[0]?.finish_reason === "stop");
    expect(stopChunk).toBeDefined();
  });

  it("populates usage from usageMetadata on final chunk", async () => {
    const streamChunks = [
      {
        candidates: [
          {
            content: { parts: [{ text: "Hello" }] },
            finishReason: undefined,
          },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, totalTokenCount: 55 },
      },
      {
        candidates: [
          {
            content: { parts: [{ text: " world" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
      },
    ];

    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: vi.fn().mockResolvedValue(
            (async function* () {
              for (const chunk of streamChunks) yield chunk;
            })(),
          ),
        };
      },
    }));

    const { GeminiProvider } = await import("../providers/gemini.js");
    const provider = new GeminiProvider({ apiKey: "test-key" });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    const last = chunks[chunks.length - 1];
    expect(last.usage).toEqual({
      prompt_tokens: 50,
      completion_tokens: 10,
      total_tokens: 60,
    });
  });

  it("maps function call parts to tool_calls chunks", async () => {
    const streamChunks = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "ReadFile",
                    args: { file_path: "test.ts" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    ];

    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: vi.fn().mockResolvedValue(
            (async function* () {
              for (const chunk of streamChunks) yield chunk;
            })(),
          ),
        };
      },
    }));

    const { GeminiProvider } = await import("../providers/gemini.js");
    const provider = new GeminiProvider({ apiKey: "test-key" });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "read test.ts" }],
      tools: [
        {
          type: "function",
          function: {
            name: "ReadFile",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { file_path: { type: "string" } },
              required: ["file_path"],
            },
          },
        },
      ],
    })) {
      chunks.push(chunk);
    }

    const tcChunk = chunks.find(
      (c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.name === "ReadFile",
    );
    expect(tcChunk).toBeDefined();
    expect(
      JSON.parse(tcChunk!.choices[0].delta.tool_calls![0].function!.arguments!),
    ).toEqual({ file_path: "test.ts" });

    const finishChunk = chunks.find(
      (c) => c.choices[0]?.finish_reason === "tool_calls",
    );
    expect(finishChunk).toBeDefined();
  });

  it("passes system instruction in config", async () => {
    const mockStream = vi.fn().mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text: "ok" }] },
              finishReason: "STOP",
            },
          ],
        };
      })(),
    );

    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        models = { generateContentStream: mockStream };
      },
    }));

    const { GeminiProvider } = await import("../providers/gemini.js");
    const provider = new GeminiProvider({ apiKey: "test-key" });

    for await (const _ of provider.chat({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      system: "You are helpful.",
    })) {
      // consume
    }

    const callArgs = mockStream.mock.calls[0][0];
    expect(callArgs.config.systemInstruction).toBe("You are helpful.");
  });

  it("converts tool result messages using function name lookup", async () => {
    const mockStream = vi.fn().mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text: "done" }] },
              finishReason: "STOP",
            },
          ],
        };
      })(),
    );

    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        models = { generateContentStream: mockStream };
      },
    }));

    const { GeminiProvider } = await import("../providers/gemini.js");
    const provider = new GeminiProvider({ apiKey: "test-key" });

    const messages: ChatMessage[] = [
      { role: "user", content: "read test.ts" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "ReadFile", arguments: '{"file_path":"test.ts"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tc-1",
        content: "file contents here",
      },
    ];

    for await (const _ of provider.chat({
      model: "gemini-2.5-flash",
      messages,
    })) {
      // consume
    }

    const callArgs = mockStream.mock.calls[0][0];
    const contents = callArgs.contents;

    // The function response should use "ReadFile" as the name, not "tc-1"
    const userTurnWithFnResponse = contents.find((c: Record<string, unknown>) =>
      (c.parts as GeminiPartLike[])?.some(
        (p: GeminiPartLike) => p.functionResponse,
      ),
    );
    expect(userTurnWithFnResponse).toBeDefined();
    const fnResponse = (userTurnWithFnResponse.parts as GeminiPartLike[]).find(
      (p: GeminiPartLike) => p.functionResponse,
    );
    expect(fnResponse!.functionResponse!.name).toBe("ReadFile");
  });
});

interface GeminiPartLike {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: unknown } };
}
