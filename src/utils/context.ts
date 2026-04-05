/**
 * Model context window sizes and effective window calculations.
 */

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic (evergreen prefixes — also match dated variants via startsWith)
  "claude-sonnet-4": 200_000,
  "claude-opus-4": 200_000,
  "claude-haiku-4": 200_000,
  "claude-haiku-3-5": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-haiku": 200_000,
  // Bedrock / Vertex model ID patterns (prefix-matched)
  "us.anthropic.claude": 200_000,
  "eu.anthropic.claude": 200_000,
  "ap.anthropic.claude": 200_000,
  "anthropic.claude": 200_000,
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o1-preview": 128_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
  // Google
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.0-flash": 1_048_576,
  "gemini-1.5-pro": 2_097_152,
  "gemini-1.5-flash": 1_048_576,
};

const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "claude-sonnet-4": 16_384,
  "claude-opus-4": 16_384,
  "claude-haiku-4": 16_384,
  "claude-haiku-3-5": 8_192,
  "claude-3-5-sonnet": 8_192,
  "claude-3-5-haiku": 8_192,
  "us.anthropic.claude": 16_384,
  "eu.anthropic.claude": 16_384,
  "ap.anthropic.claude": 16_384,
  "anthropic.claude": 16_384,
  "gpt-4o": 16_384,
  "gpt-4o-mini": 16_384,
  "gpt-4-turbo": 4_096,
  "o1": 100_000,
  "o3": 100_000,
  "o3-mini": 100_000,
  "o4-mini": 100_000,
  "gemini-2.5-pro": 65_536,
  "gemini-2.5-flash": 65_536,
  "gemini-2.0-flash": 8_192,
};

const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const MAX_OUTPUT_RESERVE = 20_000;

let customWindows: Record<string, number> = {};

/**
 * Register custom context window sizes for models not in the built-in table.
 */
export function registerContextWindows(
  windows: Record<string, number>,
): void {
  customWindows = { ...customWindows, ...windows };
}

/**
 * Get the context window size for a model. Checks custom overrides first,
 * then built-in table, then prefix-matches, then falls back to default.
 */
export function getContextWindowForModel(model: string): number {
  if (customWindows[model] !== undefined) return customWindows[model];
  if (MODEL_CONTEXT_WINDOWS[model] !== undefined)
    return MODEL_CONTEXT_WINDOWS[model];

  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(prefix)) return size;
  }
  for (const [prefix, size] of Object.entries(customWindows)) {
    if (model.startsWith(prefix)) return size;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Effective context window = total window minus space reserved for the
 * model's output during a compaction/summary request.
 */
export function getEffectiveContextWindow(
  model: string,
  maxOutputTokens?: number,
): number {
  const window = getContextWindowForModel(model);
  const reserve = Math.min(maxOutputTokens ?? MAX_OUTPUT_RESERVE, MAX_OUTPUT_RESERVE);
  return window - reserve;
}

/**
 * Auto-compact threshold: effective window minus a buffer to ensure we
 * compact before we're at the hard limit.
 */
export function getAutoCompactThreshold(
  model: string,
  maxOutputTokens?: number,
): number {
  return getEffectiveContextWindow(model, maxOutputTokens) - AUTOCOMPACT_BUFFER_TOKENS;
}

/**
 * Get the maximum output tokens a model supports. Used to clamp
 * max_tokens when extended thinking budgets are added.
 */
export function getMaxOutputTokensForModel(model: string): number {
  if (MODEL_MAX_OUTPUT_TOKENS[model] !== undefined)
    return MODEL_MAX_OUTPUT_TOKENS[model];
  for (const [prefix, size] of Object.entries(MODEL_MAX_OUTPUT_TOKENS)) {
    if (model.startsWith(prefix)) return size;
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}
