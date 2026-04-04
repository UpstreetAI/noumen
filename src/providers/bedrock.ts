import type {
  AIProvider,
  ChatParams,
  ChatStreamChunk,
} from "./types.js";
import type { CacheControlConfig } from "./cache.js";
import { streamAnthropicChat, type AnthropicStreamClient } from "./anthropic-shared.js";

export interface BedrockAnthropicProviderOptions {
  /** AWS region (default: us-east-1). */
  region?: string;
  /** Explicit AWS credentials. If omitted, the SDK uses the default credential chain. */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Model ID in Bedrock format (default: us.anthropic.claude-opus-4.6-v1:0). */
  model?: string;
  /** Custom base URL for a Bedrock-compatible endpoint. */
  baseURL?: string;
  /** Cache control config (same as AnthropicProvider). */
  cacheControl?: CacheControlConfig;
  /**
   * Pre-constructed AnthropicBedrock client. When provided, all other
   * connection options are ignored. Useful for testing or advanced setups.
   */
  client?: unknown;
}

/**
 * Anthropic provider routed through AWS Bedrock.
 *
 * Requires `@anthropic-ai/bedrock-sdk` as an optional peer dependency.
 * Install it with: `pnpm add @anthropic-ai/bedrock-sdk`
 */
export class BedrockAnthropicProvider implements AIProvider {
  private client: AnthropicStreamClient;
  private defaultModel: string;
  private cacheConfig: CacheControlConfig | undefined;

  constructor(opts: BedrockAnthropicProviderOptions) {
    if (opts.client) {
      this.client = opts.client as AnthropicStreamClient;
    } else {
      let AnthropicBedrock: new (args: Record<string, unknown>) => unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        AnthropicBedrock = require("@anthropic-ai/bedrock-sdk").AnthropicBedrock;
      } catch {
        throw new Error(
          "BedrockAnthropicProvider requires @anthropic-ai/bedrock-sdk. " +
            "Install it with: pnpm add @anthropic-ai/bedrock-sdk",
        );
      }

      const args: Record<string, unknown> = {
        awsRegion: opts.region ?? "us-east-1",
      };
      if (opts.baseURL) args.baseURL = opts.baseURL;
      if (opts.credentials) {
        args.awsAccessKey = opts.credentials.accessKeyId;
        args.awsSecretKey = opts.credentials.secretAccessKey;
        if (opts.credentials.sessionToken) {
          args.awsSessionToken = opts.credentials.sessionToken;
        }
      }

      this.client = new AnthropicBedrock(args) as unknown as AnthropicStreamClient;
    }

    this.defaultModel =
      opts.model ?? "us.anthropic.claude-opus-4.6-v1:0";
    this.cacheConfig = opts.cacheControl;
  }

  async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    yield* streamAnthropicChat(
      this.client,
      params,
      this.defaultModel,
      this.cacheConfig,
    );
  }
}
