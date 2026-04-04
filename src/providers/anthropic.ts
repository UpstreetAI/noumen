import Anthropic from "@anthropic-ai/sdk";
import type {
  AIProvider,
  ChatParams,
  ChatStreamChunk,
} from "./types.js";
import type { CacheControlConfig } from "./cache.js";
import { streamAnthropicChat, type AnthropicStreamClient } from "./anthropic-shared.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** When enabled, injects cache_control markers on system prompt, tools, and messages. */
  cacheControl?: CacheControlConfig;
}

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private defaultModel: string;
  private cacheConfig: CacheControlConfig | undefined;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });
    this.defaultModel = opts.model ?? "claude-opus-4.6";
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
