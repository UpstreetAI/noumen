import { describe, it, expect } from "vitest";
import { AiSdkProvider } from "../providers/ai-sdk/provider.js";
import type {
  AiSdkLanguageModel,
  AiSdkProviderOptions,
} from "../providers/ai-sdk/provider.js";
import type { AiSdkStreamPart } from "../providers/ai-sdk/stream.js";
import type { TranslatedCallOptions } from "../providers/ai-sdk/request.js";
import { ChatStreamError } from "../providers/types.js";

/**
 * Helper: a fake `LanguageModelV3` that records the translated call options
 * it receives and plays back a caller-provided stream.
 */
function makeModel(
  parts: AiSdkStreamPart[],
  overrides: Partial<AiSdkLanguageModel> = {},
): AiSdkLanguageModel & { lastCall: TranslatedCallOptions | undefined } {
  let lastCall: TranslatedCallOptions | undefined;
  const model: AiSdkLanguageModel & { lastCall: TranslatedCallOptions | undefined } = {
    specificationVersion: "v3",
    provider: overrides.provider ?? "openai.chat",
    modelId: overrides.modelId ?? "gpt-5",
    async doStream(options: TranslatedCallOptions) {
      lastCall = options;
      const stream = new ReadableStream<AiSdkStreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      });
      return { stream };
    },
    get lastCall() {
      return lastCall;
    },
  };
  return model;
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("AiSdkProvider", () => {
  it("reports defaultModel from the wrapped LanguageModel", () => {
    const model = makeModel([], { modelId: "claude-opus-4.6" });
    const provider = new AiSdkProvider({ model });
    expect(provider.defaultModel).toBe("claude-opus-4.6");
  });

  it("infers provider family from the model's provider string", () => {
    const anthropic = new AiSdkProvider({
      model: makeModel([], { provider: "anthropic.messages" }),
    });
    expect(anthropic.providerFamily).toBe("anthropic");

    const openai = new AiSdkProvider({
      model: makeModel([], { provider: "openai.chat" }),
    });
    expect(openai.providerFamily).toBe("openai");

    const google = new AiSdkProvider({
      model: makeModel([], { provider: "google.generative-ai" }),
    });
    expect(google.providerFamily).toBe("google");

    const openrouter = new AiSdkProvider({
      model: makeModel([], { provider: "openrouter.chat" }),
    });
    // OpenRouter speaks OpenAI wire format on our proxy.
    expect(openrouter.providerFamily).toBe("openai");

    const bedrock = new AiSdkProvider({
      model: makeModel([], { provider: "amazon-bedrock" }),
    });
    expect(bedrock.providerFamily).toBe("anthropic");
  });

  it("allows an explicit providerFamily override", () => {
    const provider = new AiSdkProvider({
      model: makeModel([], { provider: "openai.chat" }),
      providerFamily: "anthropic",
    });
    expect(provider.providerFamily).toBe("anthropic");
  });

  it("streams text deltas back as OpenAI-shaped chunks", async () => {
    const model = makeModel([
      { type: "stream-start" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hello" },
      { type: "text-delta", id: "t1", delta: " world" },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      },
    ]);
    const provider = new AiSdkProvider({ model });

    const chunks = await drain(
      provider.chat({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.map((c) => c.choices[0].delta.content).filter(Boolean)).toEqual([
      "Hello",
      " world",
    ]);

    const terminal = chunks[chunks.length - 1];
    expect(terminal.choices[0].finish_reason).toBe("stop");
    expect(terminal.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
      thinking_tokens: undefined,
    });
  });

  it("forwards AbortSignal to the underlying doStream call", async () => {
    const model = makeModel([]);
    const provider = new AiSdkProvider({ model });
    const ctrl = new AbortController();

    const iter = provider.chat({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      signal: ctrl.signal,
    });

    // Start iteration so doStream is actually invoked.
    const gen = iter[Symbol.asyncIterator]();
    await gen.next();

    expect(model.lastCall?.abortSignal).toBe(ctrl.signal);
  });

  it("translates APICallError into ChatStreamError with status + retry-after", async () => {
    const apiErr = Object.assign(new Error("rate limited"), {
      name: "AI_APICallError",
      statusCode: 429,
      responseHeaders: { "retry-after": "5" },
      isRetryable: true,
    });

    const model: AiSdkLanguageModel = {
      specificationVersion: "v3",
      provider: "openai.chat",
      modelId: "gpt-5",
      async doStream() {
        throw apiErr;
      },
    };

    const provider = new AiSdkProvider({ model });
    let caught: unknown;
    try {
      for await (const _ of provider.chat({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
      })) {
        /* no-op */
      }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ChatStreamError);
    const cse = caught as ChatStreamError;
    expect(cse.status).toBe(429);
    expect(cse.retryAfter).toBe("5");
    expect(cse.message).toBe("rate limited");
  });

  it("throws ChatStreamError('aborted') when the signal fires mid-stream", async () => {
    const ctrl = new AbortController();
    const model: AiSdkLanguageModel = {
      specificationVersion: "v3",
      provider: "openai.chat",
      modelId: "gpt-5",
      async doStream() {
        const stream = new ReadableStream<AiSdkStreamPart>({
          async start(controller) {
            controller.enqueue({ type: "text-delta", id: "t1", delta: "hi" });
            // Trigger abort before we emit the next chunk.
            ctrl.abort(new Error("user cancelled"));
            // enqueue another event so the reader's next read() resolves and
            // the translator observes the aborted signal.
            controller.enqueue({ type: "text-delta", id: "t1", delta: " there" });
            controller.close();
          },
        });
        return { stream };
      },
    };

    const provider = new AiSdkProvider({ model });
    let caught: unknown;
    try {
      for await (const _ of provider.chat({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        signal: ctrl.signal,
      })) {
        /* consume */
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChatStreamError);
    expect((caught as ChatStreamError).message).toBe("aborted");
  });

  describe("options passed to the wrapped model", () => {
    const baseArgs: AiSdkProviderOptions = {
      model: makeModel([
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    };

    async function callAndCapture(
      args: AiSdkProviderOptions,
      params: Parameters<AiSdkProvider["chat"]>[0],
    ): Promise<TranslatedCallOptions | undefined> {
      const provider = new AiSdkProvider(args);
      for await (const _ of provider.chat(params)) {
        /* drain */
      }
      return (args.model as ReturnType<typeof makeModel>).lastCall;
    }

    it("maps max_tokens -> maxOutputTokens", async () => {
      const model = makeModel([
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]);
      const call = await callAndCapture(
        { ...baseArgs, model },
        {
          model: "gpt-5",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1024,
        },
      );
      expect(call?.maxOutputTokens).toBe(1024);
    });

    it("maps reasoningEffort onto providerOptions.openai for openai family", async () => {
      const model = makeModel(
        [
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ],
        { provider: "openai.chat" },
      );
      const call = await callAndCapture(
        { ...baseArgs, model },
        {
          model: "gpt-5-nano",
          messages: [{ role: "user", content: "hi" }],
          reasoningEffort: "minimal",
        },
      );
      expect(call?.providerOptions?.openai).toEqual({ reasoningEffort: "minimal" });
    });

    it("maps thinking.budgetTokens onto Anthropic providerOptions, clamped below max_tokens", async () => {
      const model = makeModel(
        [
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ],
        { provider: "anthropic.messages" },
      );
      const call = await callAndCapture(
        { ...baseArgs, model, providerFamily: "anthropic" },
        {
          model: "claude-sonnet-4",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1024,
          thinking: { type: "enabled", budgetTokens: 2048 },
        },
      );
      expect(call?.providerOptions?.anthropic).toEqual({
        thinking: { type: "enabled", budgetTokens: 1023 },
      });
    });

    it("maps thinking disabled -> google.thinkingConfig.thinkingBudget = 0", async () => {
      const model = makeModel(
        [
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ],
        { provider: "google.generative-ai" },
      );
      const call = await callAndCapture(
        { ...baseArgs, model },
        {
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "hi" }],
          thinking: { type: "disabled" },
        },
      );
      expect(call?.providerOptions?.google).toEqual({
        thinkingConfig: { thinkingBudget: 0 },
      });
    });
  });
});
