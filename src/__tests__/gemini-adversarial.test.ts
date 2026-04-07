import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatStreamChunk } from "../providers/types.js";
import { ChatStreamError } from "../providers/types.js";

describe("GeminiProvider adversarial streams", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function makeMockStream(chunks: unknown[]) {
    return {
      models: {
        generateContentStream: vi.fn().mockResolvedValue(
          (async function* () {
            for (const chunk of chunks) yield chunk;
          })(),
        ),
      },
    };
  }

  async function createProviderWithStream(chunks: unknown[]) {
    const mockClient = makeMockStream(chunks);
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class {
        models = mockClient.models;
      },
    }));
    const { GeminiProvider } = await import("../providers/gemini.js");
    return new GeminiProvider({ apiKey: "test-key" });
  }

  async function collectChunks(provider: { chat: (p: unknown) => AsyncIterable<ChatStreamChunk> }): Promise<ChatStreamChunk[]> {
    const result: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    })) {
      result.push(chunk);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // No candidates (usage-only chunk)
  // -------------------------------------------------------------------------
  it("skips chunks with no candidates (usage-only)", async () => {
    const provider = await createProviderWithStream([
      {
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 },
        candidates: [],
      },
      {
        candidates: [{
          content: { parts: [{ text: "Hello" }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    ]);

    const chunks = await collectChunks(provider);
    const textChunks = chunks.filter(c => c.choices[0]?.delta.content);
    expect(textChunks).toHaveLength(1);
    expect(textChunks[0].choices[0].delta.content).toBe("Hello");
  });

  it("handles null candidates gracefully", async () => {
    const provider = await createProviderWithStream([
      {
        candidates: null,
        usageMetadata: { promptTokenCount: 5 },
      },
      {
        candidates: [{
          content: { parts: [{ text: "Response" }] },
          finishReason: "STOP",
        }],
      },
    ]);

    const chunks = await collectChunks(provider);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Thought without text
  // -------------------------------------------------------------------------
  it("handles thought=true without text field (part is silently skipped)", async () => {
    const provider = await createProviderWithStream([
      {
        candidates: [{
          content: {
            parts: [
              { thought: true },
              { text: "actual answer" },
            ],
          },
          finishReason: "STOP",
        }],
      },
    ]);

    const chunks = await collectChunks(provider);
    const thinkingChunks = chunks.filter(c => c.choices[0]?.delta.thinking_content !== undefined);
    expect(thinkingChunks).toHaveLength(0);

    const textChunks = chunks.filter(c => c.choices[0]?.delta.content === "actual answer");
    expect(textChunks).toHaveLength(1);
  });

  it("correctly handles thought=true WITH text", async () => {
    const provider = await createProviderWithStream([
      {
        candidates: [{
          content: {
            parts: [
              { thought: true, text: "thinking about it..." },
              { text: "here is the answer" },
            ],
          },
          finishReason: "STOP",
        }],
      },
    ]);

    const chunks = await collectChunks(provider);
    const thinkingChunks = chunks.filter(c => c.choices[0]?.delta.thinking_content !== undefined);
    expect(thinkingChunks).toHaveLength(1);
    expect(thinkingChunks[0].choices[0].delta.thinking_content).toBe("thinking about it...");

    const textChunks = chunks.filter(c =>
      c.choices[0]?.delta.content !== undefined && c.choices[0].finish_reason === null,
    );
    expect(textChunks.some(c => c.choices[0].delta.content === "here is the answer")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Empty string text
  // -------------------------------------------------------------------------
  it("yields chunk with content=\"\" for empty string part", async () => {
    const provider = await createProviderWithStream([
      {
        candidates: [{
          content: { parts: [{ text: "" }] },
        }],
      },
      {
        candidates: [{
          content: { parts: [{ text: "real content" }] },
          finishReason: "STOP",
        }],
      },
    ]);

    const chunks = await collectChunks(provider);
    const emptyChunks = chunks.filter(c =>
      c.choices[0]?.delta.content === "" && c.choices[0].finish_reason === null,
    );
    expect(emptyChunks).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // MALFORMED_FUNCTION_CALL finish reason
  // -------------------------------------------------------------------------
  it("maps MALFORMED_FUNCTION_CALL to content_filter", async () => {
    const provider = await createProviderWithStream([
      {
        candidates: [{
          content: { parts: [{ text: "partial response" }] },
          finishReason: "MALFORMED_FUNCTION_CALL",
        }],
      },
    ]);

    const chunks = await collectChunks(provider);
    const finishChunk = chunks.find(c => c.choices[0]?.finish_reason !== null);
    expect(finishChunk).toBeDefined();
    expect(finishChunk!.choices[0].finish_reason).toBe("content_filter");
  });

  it("maps SAFETY to content_filter", async () => {
    const provider = await createProviderWithStream([
      {
        candidates: [{
          content: { parts: [{ text: "..." }] },
          finishReason: "SAFETY",
        }],
      },
    ]);

    const chunks = await collectChunks(provider);
    const finishChunk = chunks.find(c => c.choices[0]?.finish_reason !== null);
    expect(finishChunk!.choices[0].finish_reason).toBe("content_filter");
  });

  // -------------------------------------------------------------------------
  // Multiple candidates (only first used)
  // -------------------------------------------------------------------------
  it("uses only the first candidate", async () => {
    const provider = await createProviderWithStream([
      {
        candidates: [
          { content: { parts: [{ text: "first candidate" }] }, finishReason: "STOP" },
          { content: { parts: [{ text: "second candidate" }] }, finishReason: "STOP" },
        ],
      },
    ]);

    const chunks = await collectChunks(provider);
    const textChunks = chunks.filter(c =>
      c.choices[0]?.delta.content !== undefined && c.choices[0].finish_reason === null,
    );
    expect(textChunks.every(c => c.choices[0].delta.content !== "second candidate")).toBe(true);
    expect(textChunks.some(c => c.choices[0].delta.content === "first candidate")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Incomplete stream (no finish reason)
  // -------------------------------------------------------------------------
  it("throws on incomplete stream (events but no finish reason)", async () => {
    const provider = await createProviderWithStream([
      {
        candidates: [{ content: { parts: [{ text: "partial" }] } }],
      },
    ]);

    await expect(collectChunks(provider)).rejects.toThrow("Gemini stream ended without finish reason");
  });

  // -------------------------------------------------------------------------
  // Tool call
  // -------------------------------------------------------------------------
  it("maps function calls with synthetic IDs", async () => {
    const provider = await createProviderWithStream([
      {
        candidates: [{
          content: {
            parts: [{
              functionCall: { name: "ReadFile", args: { file_path: "/test.ts" } },
            }],
          },
          finishReason: "STOP",
        }],
      },
    ]);

    const chunks = await collectChunks(provider);
    const toolChunk = chunks.find(c => c.choices[0]?.delta.tool_calls?.length);
    expect(toolChunk).toBeDefined();
    const tc = toolChunk!.choices[0].delta.tool_calls![0];
    expect(tc.id).toMatch(/^gemini-tc-/);
    expect(tc.function?.name).toBe("ReadFile");
    expect(tc.function?.arguments).toBe('{"file_path":"/test.ts"}');
  });
});
