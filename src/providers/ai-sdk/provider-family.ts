/**
 * Classification of an AI SDK `LanguageModelV3` by its vendor / wire format.
 *
 * We derive the family from the model's `provider` string. Providers
 * downstream plug additional provider-specific knobs onto
 * `providerOptions` in different shapes; the request translator uses the
 * family to decide whether `thinking` becomes Anthropic's
 * `thinking: { type: "enabled" }`, OpenAI's `reasoningEffort`, or
 * Gemini-native `thinkingConfig`.
 */
export type ProviderFamily =
  /** Anthropic messages API — native or via Bedrock / Vertex / OpenRouter passthrough. */
  | "anthropic"
  /** OpenAI chat/completions or Responses; also `google` when routed through a chat/completions proxy. */
  | "openai"
  /** Google Generative AI native (`@ai-sdk/google`). */
  | "google"
  /** Unknown vendor — provider-specific options are dropped. */
  | "unknown";

/**
 * Heuristic classifier. Call sites can override by passing an explicit
 * `providerFamily` to `AiSdkProvider`.
 *
 * Examples of provider strings in the wild:
 * - `@ai-sdk/openai` v3 -> `"openai.chat"` / `"openai.responses"`
 * - `@ai-sdk/anthropic` v3 -> `"anthropic.messages"`
 * - `@ai-sdk/google` v3 -> `"google.generative-ai"`
 * - `@ai-sdk/amazon-bedrock` with Claude -> `"amazon-bedrock"` (Anthropic wire format)
 * - `@ai-sdk/google-vertex` with Claude -> `"google-vertex.anthropic"`
 * - `@openrouter/ai-sdk-provider` -> `"openrouter.chat"` (OpenAI-compat wire format)
 * - `ollama-ai-provider-v2` -> `"ollama.chat"` (OpenAI-compat wire format)
 */
export function inferProviderFamily(providerString: string): ProviderFamily {
  const p = providerString.toLowerCase();

  if (p.includes("anthropic")) return "anthropic";
  if (p.startsWith("amazon-bedrock") || p.startsWith("bedrock")) {
    return "anthropic";
  }

  // `@ai-sdk/google` native Gemini
  if (p.startsWith("google.") || p === "google" || p.startsWith("google-generative-ai")) {
    return "google";
  }

  // Everything else that speaks OpenAI wire format:
  // `openai.*`, `openrouter.*`, `ollama.*`, custom `*.chat`, etc.
  if (
    p.startsWith("openai") ||
    p.startsWith("openrouter") ||
    p.startsWith("ollama") ||
    p.endsWith(".chat") ||
    p.endsWith(".responses")
  ) {
    return "openai";
  }

  return "unknown";
}
