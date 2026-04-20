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
      model: "claude-sonnet-4",
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
      model: "claude-sonnet-4",
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
      model: "claude-sonnet-4",
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

describe("GeminiProvider — abort signal wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("passes abort signal via httpOptions, not as top-level config", async () => {
    let capturedConfig: Record<string, unknown> = {};

    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
            capturedConfig = params.config as Record<string, unknown>;
            return (async function* () {
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: "ok" }] },
                    finishReason: "STOP",
                  },
                ],
              };
            })();
          }),
        };
      },
    }));

    const { GeminiProvider } = await import("../providers/gemini.js");
    const provider = new GeminiProvider({ apiKey: "test-key" });

    const ac = new AbortController();
    for await (const _ of provider.chat({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      signal: ac.signal,
    })) {
      // consume
    }

    // Signal should be under httpOptions, not as a top-level abortSignal
    expect(capturedConfig.abortSignal).toBeUndefined();
    expect((capturedConfig.httpOptions as Record<string, unknown>)?.signal).toBe(ac.signal);
  });
});

describe("OpenRouterProvider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sets OpenRouter base URL and default model", async () => {
    let capturedOpts: Record<string, unknown> = {};

    vi.doMock("openai", () => ({
      default: class {
        constructor(opts: Record<string, unknown>) {
          capturedOpts = opts;
        }
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue(
              (async function* () {
                yield {
                  id: "c1",
                  model: "anthropic/claude-sonnet-4",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                };
              })(),
            ),
          },
        };
      },
    }));

    const { OpenRouterProvider } = await import("../providers/openrouter.js");
    const provider = new OpenRouterProvider({ apiKey: "or-test-key" });

    for await (const _ of provider.chat({
      model: "anthropic/claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    })) {
      // consume
    }

    expect(capturedOpts.apiKey).toBe("or-test-key");
    expect(capturedOpts.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("passes appName and appUrl as default headers", async () => {
    let capturedOpts: Record<string, unknown> = {};

    vi.doMock("openai", () => ({
      default: class {
        constructor(opts: Record<string, unknown>) {
          capturedOpts = opts;
        }
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue(
              (async function* () {
                yield {
                  id: "c1",
                  model: "anthropic/claude-sonnet-4",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                };
              })(),
            ),
          },
        };
      },
    }));

    const { OpenRouterProvider } = await import("../providers/openrouter.js");
    new OpenRouterProvider({
      apiKey: "or-test-key",
      appName: "My App",
      appUrl: "https://myapp.com",
    });

    const headers = capturedOpts.defaultHeaders as Record<string, string>;
    expect(headers["X-Title"]).toBe("My App");
    expect(headers["HTTP-Referer"]).toBe("https://myapp.com");
  });

  it("streams chunks through the inherited OpenAI chat method", async () => {
    const mockChunks = [
      {
        id: "c1",
        model: "anthropic/claude-sonnet-4",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Hello from OpenRouter" }, finish_reason: null },
        ],
      },
      {
        id: "c2",
        model: "anthropic/claude-sonnet-4",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop" },
        ],
      },
    ];

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue(
              (async function* () {
                for (const chunk of mockChunks) yield chunk;
              })(),
            ),
          },
        };
      },
    }));

    const { OpenRouterProvider } = await import("../providers/openrouter.js");
    const provider = new OpenRouterProvider({ apiKey: "or-test-key" });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "anthropic/claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe("Hello from OpenRouter");
    expect(chunks[1].choices[0].finish_reason).toBe("stop");
  });
});

interface GeminiPartLike {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: unknown } };
}

describe("OpenAIProvider — O-series models", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sets max_completion_tokens instead of max_tokens for O-series models", async () => {
    let capturedParams: Record<string, unknown> = {};

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
              capturedParams = params;
              return (async function* () {
                yield {
                  id: "c1", model: "o1",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                };
              })();
            }),
          },
        };
      },
    }));

    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    for await (const _ of provider.chat({
      model: "o1",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    })) {
      // consume
    }

    expect(capturedParams.max_completion_tokens).toBe(4096);
    expect(capturedParams.max_tokens).toBeUndefined();
  });

  it("maps reasoning_content to thinking_content in deltas", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue(
              (async function* () {
                yield {
                  id: "c1", model: "o1",
                  choices: [{
                    index: 0,
                    delta: { content: "answer", reasoning_content: "thought process" },
                    finish_reason: null,
                  }],
                };
                yield {
                  id: "c2", model: "o1",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                };
              })(),
            ),
          },
        };
      },
    }));

    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "o1",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    const thinkingChunk = chunks.find((c) => c.choices[0].delta.thinking_content);
    expect(thinkingChunk).toBeDefined();
    expect(thinkingChunk!.choices[0].delta.thinking_content).toBe("thought process");
  });
});

// ---------------------------------------------------------------------------
// OpenAI compatMode
// ---------------------------------------------------------------------------
describe("OpenAI compatMode", () => {
  it("OllamaProvider inherits compatMode and omits stream_options", async () => {
    const { OllamaProvider } = await import("../providers/ollama.js");
    const p = new OllamaProvider({ model: "test-model" });
    expect((p as any).compatMode).toBe(true);
  });

  it("default OpenAI provider does not use compatMode", async () => {
    const { OpenAIProvider } = await import("../providers/openai.js");
    const p = new OpenAIProvider({ apiKey: "test" });
    expect((p as any).compatMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OpenAI o-series max_completion_tokens
// ---------------------------------------------------------------------------
describe("OpenAI o-series max_completion_tokens", () => {
  it("defaults max_completion_tokens to 16384 when max_tokens is undefined", async () => {
    vi.resetModules();
    let capturedParams: any;
    const mockCreate = vi.fn().mockImplementation((params: any) => {
      capturedParams = params;
      return Promise.resolve(
        (async function* () {
          yield {
            id: "c1",
            model: "o1-mini",
            choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
          };
        })(),
      );
    });

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: mockCreate } };
      },
    }));
    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ apiKey: "test" });

    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chat({
      model: "o1-mini",
      messages: [{ role: "user", content: "test" }],
    })) {
      chunks.push(c);
    }

    expect(capturedParams.max_completion_tokens).toBe(16384);
    expect(capturedParams.max_tokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OpenAI reasoning-model routing (GPT-5 family + o-series)
//
// Guards the single regex in openai.ts that decides whether a request
// goes down the reasoning contract (`max_completion_tokens`,
// `reasoning_effort`, no `temperature`) vs the classical contract
// (`max_tokens`, `temperature`). The GPT-5 family was missed by the
// original `^o[1-9]` pattern and produced a 400 from OpenAI at runtime.
// ---------------------------------------------------------------------------
describe("OpenAI reasoning-model routing", () => {
  async function runWithModel(
    model: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    vi.resetModules();
    let capturedParams: Record<string, unknown> = {};
    const mockCreate = vi.fn().mockImplementation((params: Record<string, unknown>) => {
      capturedParams = params;
      return Promise.resolve(
        (async function* () {
          yield {
            id: "c1",
            model,
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          };
        })(),
      );
    });
    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: mockCreate } };
      },
    }));
    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ apiKey: "test" });
    for await (const _ of provider.chat({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 60,
      temperature: 0.5,
      ...extra,
    })) {
      // drain
    }
    return capturedParams;
  }

  it.each([
    ["gpt-5"],
    ["gpt-5-mini"],
    ["gpt-5-nano"],
    ["gpt-5.4"],
    ["gpt-5.4-nano"],
    ["GPT-5.4-NANO"], // case-insensitive
    ["o1"],
    ["o1-mini"],
    ["o3"],
    ["o4-mini"],
  ])(
    "%s goes down the reasoning contract (max_completion_tokens, no temperature)",
    async (model) => {
      const params = await runWithModel(model);
      expect(params.max_completion_tokens).toBe(60);
      expect(params.max_tokens).toBeUndefined();
      // temperature is rejected by OpenAI for reasoning models, so the
      // provider must drop it even when the caller passed one.
      expect(params.temperature).toBeUndefined();
    },
  );

  it.each([
    ["gpt-4o"],
    ["gpt-4o-mini"],
    ["gpt-4.1"],
    ["gpt-4.1-mini"],
    ["gpt-4.1-nano"],
    ["gpt-3.5-turbo"],
  ])(
    "%s stays on the classical contract (max_tokens + temperature)",
    async (model) => {
      const params = await runWithModel(model);
      expect(params.max_tokens).toBe(60);
      expect(params.temperature).toBe(0.5);
      expect(params.max_completion_tokens).toBeUndefined();
      expect(params.reasoning_effort).toBeUndefined();
    },
  );

  it("threads reasoningEffort through as reasoning_effort on reasoning models", async () => {
    const params = await runWithModel("gpt-5.4-nano", {
      reasoningEffort: "minimal",
    });
    expect(params.reasoning_effort).toBe("minimal");
  });

  it("reasoningEffort takes precedence over thinking.type === enabled", async () => {
    const params = await runWithModel("o3", {
      reasoningEffort: "low",
      thinking: { type: "enabled", budgetTokens: 1024 },
    });
    expect(params.reasoning_effort).toBe("low");
  });

  it("falls back to reasoning_effort=high when thinking is enabled and no explicit effort given", async () => {
    const params = await runWithModel("o3", {
      thinking: { type: "enabled", budgetTokens: 1024 },
    });
    expect(params.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort on classical models even when reasoningEffort is passed", async () => {
    const params = await runWithModel("gpt-4o", {
      reasoningEffort: "minimal",
    });
    expect(params.reasoning_effort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gemini incomplete stream detection
// ---------------------------------------------------------------------------
describe("Gemini incomplete stream detection", () => {
  it("throws on stream that ends without finish reason", async () => {
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async function* () {
            yield {
              candidates: [{ content: { parts: [{ text: "partial" }] } }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            };
            // No finish reason in the candidate
          },
        };
      },
      Type: { STRING: "STRING" },
    }));
    const { GeminiProvider } = await import("../providers/gemini.js");
    const provider = new GeminiProvider({ apiKey: "test" });

    await expect(async () => {
      const chunks: ChatStreamChunk[] = [];
      for await (const c of provider.chat({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "test" }],
      })) {
        chunks.push(c);
      }
    }).rejects.toThrow(/finish reason/i);
  });
});

// ---------------------------------------------------------------------------
// Gemini empty assistant message preservation
// ---------------------------------------------------------------------------
describe("Gemini empty assistant message", () => {
  it("does not drop empty assistant messages in conversion", async () => {
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async function* () {
            yield {
              candidates: [
                {
                  content: { parts: [{ text: "ok" }] },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            };
          },
        };
      },
      Type: { STRING: "STRING" },
    }));
    const { GeminiProvider } = await import("../providers/gemini.js");
    const provider = new GeminiProvider({ apiKey: "test" });

    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "user", content: "hello" },
    ];

    const { contents } = (provider as any).convertMessages(undefined, messages);
    expect(contents.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Bug fix: AbortSignal passed in request options, not body
// ---------------------------------------------------------------------------
describe("Anthropic abort signal wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("passes signal via options arg, not in the request body", async () => {
    let capturedParams: Record<string, unknown> = {};
    let capturedOptions: Record<string, unknown> | undefined;

    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          stream: (params: Record<string, unknown>, options?: Record<string, unknown>) => {
            capturedParams = params;
            capturedOptions = options;
            return (async function* () {
              yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
              yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
              yield { type: "message_stop" };
            })();
          },
        };
      },
    }));

    const { AnthropicProvider } = await import("../providers/anthropic.js");
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    const ac = new AbortController();

    for await (const _ of provider.chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      signal: ac.signal,
    })) {
      // consume
    }

    expect(capturedParams.signal).toBeUndefined();
    expect(capturedOptions?.signal).toBe(ac.signal);
  });

  it("does not pass options when no signal provided", async () => {
    let capturedOptions: Record<string, unknown> | undefined = { sentinel: true };

    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          stream: (_params: Record<string, unknown>, options?: Record<string, unknown>) => {
            capturedOptions = options;
            return (async function* () {
              yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
              yield { type: "message_stop" };
            })();
          },
        };
      },
    }));

    const { AnthropicProvider } = await import("../providers/anthropic.js");
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    for await (const _ of provider.chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    })) {
      // consume
    }

    expect(capturedOptions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bug fix: maxRetries: 0 on SDK clients
// ---------------------------------------------------------------------------
describe("SDK maxRetries disabled", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("AnthropicProvider passes maxRetries: 0", async () => {
    let capturedOpts: Record<string, unknown> = {};

    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        constructor(opts: Record<string, unknown>) {
          capturedOpts = opts;
        }
        messages = {
          stream: () =>
            (async function* () {
              yield { type: "message_stop" };
            })(),
        };
      },
    }));

    const { AnthropicProvider } = await import("../providers/anthropic.js");
    new AnthropicProvider({ apiKey: "test-key" });
    expect(capturedOpts.maxRetries).toBe(0);
  });

  it("OpenAIProvider passes maxRetries: 0", async () => {
    let capturedOpts: Record<string, unknown> = {};

    vi.doMock("openai", () => ({
      default: class {
        constructor(opts: Record<string, unknown>) {
          capturedOpts = opts;
        }
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue(
              (async function* () {
                yield { id: "c1", model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
              })(),
            ),
          },
        };
      },
    }));

    const { OpenAIProvider } = await import("../providers/openai.js");
    new OpenAIProvider({ apiKey: "test-key" });
    expect(capturedOpts.maxRetries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gemini blocked finish reasons → content_filter
// ---------------------------------------------------------------------------
describe("Gemini blocked finish reasons", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  for (const reason of ["BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL"]) {
    it(`maps ${reason} to content_filter`, async () => {
      const streamChunks = [
        {
          candidates: [
            {
              content: { parts: [{ text: "partial" }] },
              finishReason: undefined,
            },
          ],
        },
        {
          candidates: [
            {
              content: { parts: [] },
              finishReason: reason,
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

      const filtered = chunks.find((c) => c.choices[0]?.finish_reason === "content_filter");
      expect(filtered).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Gemini thinkingConfig — honors explicit `{ type: "disabled" }` so
// Gemini 2.5-flash (thinking-on by default) doesn't burn the caller's
// maxOutputTokens budget on internal reasoning. Used by short-lived
// structural round-trips like auto-title generation.
// ---------------------------------------------------------------------------
describe("Gemini thinkingConfig routing", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function runWithThinking(
    thinking: { type: "enabled"; budgetTokens: number } | { type: "disabled" } | undefined,
  ): Promise<Record<string, unknown>> {
    let capturedConfig: Record<string, unknown> = {};
    const generateContentStream = vi.fn().mockImplementation((req: { config: Record<string, unknown> }) => {
      capturedConfig = req.config;
      return Promise.resolve(
        (async function* () {
          yield {
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          };
        })(),
      );
    });
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        models = { generateContentStream };
      },
    }));
    const { GeminiProvider } = await import("../providers/gemini.js");
    const provider = new GeminiProvider({ apiKey: "test" });
    for await (const _ of provider.chat({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 60,
      ...(thinking ? { thinking } : {}),
    })) {
      // drain
    }
    return capturedConfig;
  }

  it("sets thinkingBudget: 0 when thinking: { type: 'disabled' }", async () => {
    const config = await runWithThinking({ type: "disabled" });
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("omits thinkingConfig entirely when thinking is not passed", async () => {
    const config = await runWithThinking(undefined);
    expect(config.thinkingConfig).toBeUndefined();
  });

  it("forwards the budget when thinking is enabled", async () => {
    const config = await runWithThinking({ type: "enabled", budgetTokens: 1024 });
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 1024 });
  });

  it("treats enabled with budgetTokens <= 0 as off (no thinkingConfig set)", async () => {
    const config = await runWithThinking({ type: "enabled", budgetTokens: 0 });
    expect(config.thinkingConfig).toBeUndefined();
  });
});
