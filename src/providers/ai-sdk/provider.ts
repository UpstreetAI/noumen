/**
 * `AiSdkProvider` — single noumen `AIProvider` implementation that wraps
 * any Vercel AI SDK `LanguageModelV3` (`@ai-sdk/openai`, `@ai-sdk/anthropic`,
 * `@ai-sdk/google`, `@openrouter/ai-sdk-provider`, `@ai-sdk/amazon-bedrock`,
 * `@ai-sdk/google-vertex`, `ollama-ai-provider-v2`, ...).
 *
 * Callers construct the vendor SDK model (often via pocketuniverse's metered
 * `createProvider(...)` factory so traffic flows through `/api/ai/*` with
 * JWT auth + credit metering) and hand it to `new AiSdkProvider({ model })`.
 * The noumen pipeline then keeps talking to one uniform `chat()` surface.
 *
 * See `/Users/a/mastra/packages/core/src/llm/model/aisdk/v5/model.ts` for
 * the reference wrapper; we intentionally strip out mastra-specific event
 * plumbing and keep the surface area to just `AIProvider.chat`.
 */

import type { AIProvider, ChatParams, ChatStreamChunk } from "../types.js";
import type { CacheControlConfig } from "../cache.js";
import { mapApiCallError } from "./errors.js";
import { translateRequest, type TranslatedCallOptions } from "./request.js";
import { translateStream, type AiSdkStreamPart } from "./stream.js";
import {
  inferProviderFamily,
  type ProviderFamily,
} from "./provider-family.js";

/**
 * Minimal subset of `LanguageModelV3` we require. Using a structural type
 * means tests can pass lightweight mocks and we don't have a hard import
 * dependency on `@ai-sdk/provider` types (peer-only).
 */
export interface AiSdkLanguageModel {
  readonly specificationVersion: "v2" | "v3";
  readonly provider: string;
  readonly modelId: string;
  doStream(options: TranslatedCallOptions): Promise<{
    stream: ReadableStream<AiSdkStreamPart>;
  }>;
}

export interface AiSdkProviderOptions {
  /** The AI SDK language model instance (any v2 or v3 provider). */
  model: AiSdkLanguageModel;
  /**
   * Fallback model id reported by `AIProvider.defaultModel`. When omitted
   * we use `model.modelId`. `ChatParams.model`, when provided, always
   * wins at call time because the AI SDK model is already bound to its
   * id — this field is purely informational for consumers that ask for
   * a default without wiring in a resolver.
   */
  defaultModel?: string;
  /**
   * Override the provider family classifier. Use this if you know the
   * model's vendor more precisely than the string-based heuristic (e.g.
   * a custom base URL forwards Anthropic traffic but reports
   * `provider: "openai.chat"`).
   */
  providerFamily?: ProviderFamily;
  /**
   * Anthropic prompt-cache configuration. No-op when `providerFamily` is
   * not Anthropic. When enabled, noumen inserts a single cache breakpoint
   * on the appropriate message position (respects `ChatParams.skipCacheWrite`).
   */
  cacheConfig?: CacheControlConfig;
}

export class AiSdkProvider implements AIProvider {
  readonly defaultModel: string;
  readonly providerFamily: ProviderFamily;
  private readonly model: AiSdkLanguageModel;
  private readonly cacheConfig?: CacheControlConfig;

  constructor(opts: AiSdkProviderOptions) {
    this.model = opts.model;
    this.defaultModel = opts.defaultModel ?? opts.model.modelId;
    this.providerFamily =
      opts.providerFamily ?? inferProviderFamily(opts.model.provider);
    this.cacheConfig = opts.cacheConfig;
  }

  async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    const call = translateRequest(params, {
      providerFamily: this.providerFamily,
      cacheConfig: this.cacheConfig,
    });

    let result: { stream: ReadableStream<AiSdkStreamPart> };
    try {
      result = await this.model.doStream(call);
    } catch (err) {
      throw mapApiCallError(err);
    }

    const modelId = params.model ?? this.defaultModel;
    yield* translateStream(result.stream, modelId, params.signal);
  }
}
