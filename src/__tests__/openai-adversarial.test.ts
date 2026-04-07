import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatStreamChunk } from "../providers/types.js";

describe("OpenAIProvider adversarial streams", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function makeMockCreate(chunks: unknown[]) {
    return vi.fn().mockResolvedValue(
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    );
  }

  async function createProvider(mockCreate: ReturnType<typeof vi.fn>) {
    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: mockCreate } };
      },
    }));
    const { OpenAIProvider } = await import("../providers/openai.js");
    return new OpenAIProvider({ apiKey: "test-key" });
  }

  async function collectChunks(provider: { chat: (p: unknown) => AsyncIterable<ChatStreamChunk> }): Promise<ChatStreamChunk[]> {
    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }
    return chunks;
  }

  // -------------------------------------------------------------------------
  // 2A: Missing choices array
  // -------------------------------------------------------------------------
  it("handles chunk with missing choices (usage-only)", async () => {
    const mockCreate = makeMockCreate([
      {
        id: "c1",
        model: "gpt-4o",
        choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
      },
      {
        id: "c2",
        model: "gpt-4o",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
      {
        id: "c3",
        model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);

    const provider = await createProvider(mockCreate);
    const chunks = await collectChunks(provider);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const usageChunk = chunks.find(c => c.usage && c.choices.length === 0);
    expect(usageChunk).toBeDefined();
    expect(usageChunk!.usage!.prompt_tokens).toBe(10);
  });

  it("handles chunk where choices is undefined", async () => {
    const mockCreate = makeMockCreate([
      {
        id: "c1",
        model: "gpt-4o",
        choices: undefined,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
      {
        id: "c2",
        model: "gpt-4o",
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
      },
      {
        id: "c3",
        model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);

    const provider = await createProvider(mockCreate);
    const chunks = await collectChunks(provider);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Tool call with undefined function on follow-up delta
  // -------------------------------------------------------------------------
  it("handles tool_call delta with undefined function", async () => {
    const mockCreate = makeMockCreate([
      {
        id: "c1",
        model: "gpt-4o",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "ReadFile", arguments: '{"file' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "c2",
        model: "gpt-4o",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '_path": "test.ts"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "c3",
        model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);

    const provider = await createProvider(mockCreate);
    const chunks = await collectChunks(provider);

    const toolChunks = chunks.filter(c => c.choices[0]?.delta.tool_calls?.length);
    expect(toolChunks.length).toBeGreaterThanOrEqual(2);
    expect(toolChunks[0].choices[0].delta.tool_calls![0].function?.name).toBe("ReadFile");
    expect(toolChunks[1].choices[0].delta.tool_calls![0].function?.arguments).toBe('_path": "test.ts"}');
  });

  // -------------------------------------------------------------------------
  // Compat mode: no usage chunk
  // -------------------------------------------------------------------------
  it("works in compat mode without usage data", async () => {
    const mockCreate = makeMockCreate([
      {
        id: "c1",
        model: "gpt-4o",
        choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
      },
      {
        id: "c2",
        model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: mockCreate } };
      },
    }));
    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ apiKey: "test-key", compatMode: true });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].usage).toBeUndefined();
    expect(chunks[1].usage).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // reasoning_content mapping
  // -------------------------------------------------------------------------
  it("maps reasoning_content to thinking_content", async () => {
    const mockCreate = makeMockCreate([
      {
        id: "c1",
        model: "o3",
        choices: [{
          index: 0,
          delta: { reasoning_content: "Let me think about this" },
          finish_reason: null,
        }],
      },
      {
        id: "c2",
        model: "o3",
        choices: [{
          index: 0,
          delta: { content: "The answer is 42" },
          finish_reason: null,
        }],
      },
      {
        id: "c3",
        model: "o3",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);

    const provider = await createProvider(mockCreate);
    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "o3",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0].choices[0].delta.thinking_content).toBe("Let me think about this");
    expect(chunks[1].choices[0].delta.content).toBe("The answer is 42");
  });

  // -------------------------------------------------------------------------
  // Multiple choices in one chunk
  // -------------------------------------------------------------------------
  it("handles multiple choices in one chunk", async () => {
    const mockCreate = makeMockCreate([
      {
        id: "c1",
        model: "gpt-4o",
        choices: [
          { index: 0, delta: { content: "Choice 0" }, finish_reason: null },
          { index: 1, delta: { content: "Choice 1" }, finish_reason: null },
        ],
      },
      {
        id: "c2",
        model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);

    const provider = await createProvider(mockCreate);
    const chunks = await collectChunks(provider);
    expect(chunks[0].choices).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe("Choice 0");
    expect(chunks[0].choices[1].delta.content).toBe("Choice 1");
  });
});
