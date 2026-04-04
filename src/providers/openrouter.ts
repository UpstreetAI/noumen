import { OpenAIProvider } from "./openai.js";

export interface OpenRouterProviderOptions {
  apiKey: string;
  model?: string;
  /** Displayed on openrouter.ai rankings. Sent as the `X-Title` header. */
  appName?: string;
  /** Used for openrouter.ai rankings. Sent as the `HTTP-Referer` header. */
  appUrl?: string;
}

export class OpenRouterProvider extends OpenAIProvider {
  constructor(opts: OpenRouterProviderOptions) {
    super({
      apiKey: opts.apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      model: opts.model ?? "anthropic/claude-opus-4.6",
      defaultHeaders: {
        ...(opts.appName ? { "X-Title": opts.appName } : {}),
        ...(opts.appUrl ? { "HTTP-Referer": opts.appUrl } : {}),
      },
    });
  }
}
