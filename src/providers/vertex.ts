import type {
  AIProvider,
  ChatParams,
  ChatStreamChunk,
} from "./types.js";
import type { CacheControlConfig } from "./cache.js";
import { streamAnthropicChat, type AnthropicStreamClient } from "./anthropic-shared.js";

export interface VertexAnthropicProviderOptions {
  /** GCP project ID. If omitted, inferred from application default credentials. */
  projectId?: string;
  /** GCP region (default: us-east5). */
  region?: string;
  /**
   * A `GoogleAuth` instance or any object with a compatible `getClient()` method.
   * If omitted, the provider creates one using application default credentials.
   * Requires `google-auth-library` as a peer dependency.
   */
  googleAuth?: unknown;
  /** Model ID in Vertex format (default: claude-opus-4.6). */
  model?: string;
  /** Cache control config (same as AnthropicProvider). */
  cacheControl?: CacheControlConfig;
  /** Custom base URL for the Vertex API endpoint. */
  baseURL?: string;
  /**
   * Pre-constructed AnthropicVertex client. When provided, all other
   * connection options are ignored. Useful for testing or advanced setups.
   */
  client?: unknown;
}

/**
 * Anthropic provider routed through Google Cloud Vertex AI.
 *
 * Requires `@anthropic-ai/vertex-sdk` as an optional peer dependency.
 * If `googleAuth` is not provided, also requires `google-auth-library`.
 * Install with: `pnpm add @anthropic-ai/vertex-sdk google-auth-library`
 */
export class VertexAnthropicProvider implements AIProvider {
  private client: AnthropicStreamClient;
  private defaultModel: string;
  private cacheConfig: CacheControlConfig | undefined;

  constructor(opts: VertexAnthropicProviderOptions) {
    if (opts.client) {
      this.client = opts.client as AnthropicStreamClient;
    } else {
      let AnthropicVertex: new (args: Record<string, unknown>) => unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        AnthropicVertex = require("@anthropic-ai/vertex-sdk").AnthropicVertex;
      } catch {
        throw new Error(
          "VertexAnthropicProvider requires @anthropic-ai/vertex-sdk. " +
            "Install it with: pnpm add @anthropic-ai/vertex-sdk",
        );
      }

      let googleAuth = opts.googleAuth;
      if (!googleAuth) {
        let GoogleAuth: new (args: Record<string, unknown>) => unknown;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          GoogleAuth = require("google-auth-library").GoogleAuth;
        } catch {
          throw new Error(
            "VertexAnthropicProvider requires google-auth-library when googleAuth is not provided. " +
              "Install it with: pnpm add google-auth-library",
          );
        }
        const authArgs: Record<string, unknown> = {
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        };
        if (opts.projectId) authArgs.projectId = opts.projectId;
        googleAuth = new GoogleAuth(authArgs);
      }

      const args: Record<string, unknown> = {
        region: opts.region ?? "us-east5",
        googleAuth,
      };
      if (opts.projectId) args.projectId = opts.projectId;
      if (opts.baseURL) args.baseURL = opts.baseURL;

      this.client = new AnthropicVertex(args) as unknown as AnthropicStreamClient;
    }

    this.defaultModel = opts.model ?? "claude-opus-4.6";
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
