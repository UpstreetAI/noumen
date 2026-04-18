import Anthropic from "@anthropic-ai/sdk";
import type {
  AIProvider,
  ChatParams,
  ChatStreamChunk,
} from "./types.js";
import type { CacheControlConfig } from "./cache.js";
import {
  streamAnthropicChat,
  type AnthropicStreamClient,
  DEFAULT_ANTHROPIC_MODEL,
} from "./anthropic-shared.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** When enabled, injects cache_control markers on system prompt, tools, and messages. */
  cacheControl?: CacheControlConfig;
}

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  readonly defaultModel: string;
  private cacheConfig: CacheControlConfig | undefined;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      maxRetries: 0,
    });
    this.defaultModel = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.cacheConfig = opts.cacheControl;
  }

  async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    yield* streamAnthropicChat(
      this.client as unknown as AnthropicStreamClient,
      params,
      this.defaultModel,
      this.cacheConfig,
    );
  }
}
