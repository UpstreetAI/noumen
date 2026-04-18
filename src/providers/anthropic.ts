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
  readonly defaultModel: string;
  private cacheConfig: CacheControlConfig | undefined;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      maxRetries: 0,
    });
    // Anthropic model IDs use hyphens throughout (e.g. `claude-opus-4-7`).
    // A dot-separated fallback silently 404s against the real API, which is
    // especially nasty when the string only surfaces via Thread's fallback.
    this.defaultModel = opts.model ?? "claude-opus-4-7";
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
