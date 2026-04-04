import type { ModelPricing, UsageRecord } from "./types.js";

// Pricing tiers (USD per 1M tokens), sourced from public pricing docs
const TIER_3_15: ModelPricing = { inputTokens: 3, outputTokens: 15, cacheReadTokens: 0.3, cacheWriteTokens: 3.75 };
const TIER_5_25: ModelPricing = { inputTokens: 5, outputTokens: 25, cacheReadTokens: 0.5, cacheWriteTokens: 6.25 };
const TIER_15_75: ModelPricing = { inputTokens: 15, outputTokens: 75, cacheReadTokens: 1.5, cacheWriteTokens: 18.75 };
const TIER_30_150: ModelPricing = { inputTokens: 30, outputTokens: 150, cacheReadTokens: 3, cacheWriteTokens: 37.5 };
const TIER_HAIKU_35: ModelPricing = { inputTokens: 0.8, outputTokens: 4, cacheReadTokens: 0.08, cacheWriteTokens: 1 };
const TIER_HAIKU_45: ModelPricing = { inputTokens: 1, outputTokens: 5, cacheReadTokens: 0.1, cacheWriteTokens: 1.25 };

// OpenAI tiers
const TIER_GPT4O: ModelPricing = { inputTokens: 2.5, outputTokens: 10, cacheReadTokens: 1.25 };
const TIER_GPT4O_MINI: ModelPricing = { inputTokens: 0.15, outputTokens: 0.6, cacheReadTokens: 0.075 };
const TIER_GPT41: ModelPricing = { inputTokens: 2, outputTokens: 8, cacheReadTokens: 0.5 };
const TIER_GPT41_MINI: ModelPricing = { inputTokens: 0.4, outputTokens: 1.6, cacheReadTokens: 0.1 };
const TIER_GPT41_NANO: ModelPricing = { inputTokens: 0.1, outputTokens: 0.4, cacheReadTokens: 0.025 };
const TIER_O3: ModelPricing = { inputTokens: 2, outputTokens: 8, cacheReadTokens: 0.5 };
const TIER_O3_MINI: ModelPricing = { inputTokens: 1.1, outputTokens: 4.4, cacheReadTokens: 0.275 };
const TIER_O4_MINI: ModelPricing = { inputTokens: 1.1, outputTokens: 4.4, cacheReadTokens: 0.275 };

// Google Gemini tiers
const TIER_GEMINI_FLASH: ModelPricing = { inputTokens: 0.075, outputTokens: 0.3 };
const TIER_GEMINI_PRO: ModelPricing = { inputTokens: 1.25, outputTokens: 5 };
const TIER_GEMINI_FLASH_LITE: ModelPricing = { inputTokens: 0.0375, outputTokens: 0.15 };

/**
 * Default pricing table for common models. Keys are matched as substrings
 * against the model ID so versioned model strings (e.g. `claude-sonnet-4`)
 * resolve correctly.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "claude-sonnet-4": TIER_5_25,
  "claude-opus-4": TIER_15_75,
  "claude-3-5-sonnet": TIER_3_15,
  "claude-3-5-haiku": TIER_HAIKU_45,
  "claude-3-haiku": TIER_HAIKU_35,
  "claude-3-opus": TIER_30_150,

  // OpenAI
  "gpt-4o-mini": TIER_GPT4O_MINI,
  "gpt-4o": TIER_GPT4O,
  "gpt-4.1-mini": TIER_GPT41_MINI,
  "gpt-4.1-nano": TIER_GPT41_NANO,
  "gpt-4.1": TIER_GPT41,
  "o4-mini": TIER_O4_MINI,
  "o3-mini": TIER_O3_MINI,
  "o3": TIER_O3,

  // Google Gemini
  "gemini-2.5-flash": TIER_GEMINI_FLASH,
  "gemini-2.5-pro": TIER_GEMINI_PRO,
  "gemini-2.0-flash": TIER_GEMINI_FLASH,
  "gemini-2.0-flash-lite": TIER_GEMINI_FLASH_LITE,
  "gemini-1.5-flash": TIER_GEMINI_FLASH,
  "gemini-1.5-pro": TIER_GEMINI_PRO,
};

/**
 * Find pricing for a model by checking if the model string contains any
 * known pricing key as a substring. More specific keys (longer) are
 * checked first to ensure e.g. "gpt-4o-mini" matches before "gpt-4o".
 */
export function findModelPricing(
  model: string,
  pricing: Record<string, ModelPricing>,
): ModelPricing | null {
  const sortedKeys = Object.keys(pricing).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (model.includes(key)) {
      return pricing[key];
    }
  }
  return null;
}

/**
 * Calculate USD cost for a usage record using the given pricing table.
 * Returns 0 if the model is not found in the pricing table.
 */
export function calculateCost(
  model: string,
  usage: UsageRecord,
  pricing: Record<string, ModelPricing> = DEFAULT_PRICING,
): number {
  const p = findModelPricing(model, pricing);
  if (!p) return 0;

  const perMillion = 1_000_000;
  let cost = 0;
  cost += (usage.prompt_tokens / perMillion) * p.inputTokens;
  cost += (usage.completion_tokens / perMillion) * p.outputTokens;
  if (usage.cache_read_tokens && p.cacheReadTokens) {
    cost += (usage.cache_read_tokens / perMillion) * p.cacheReadTokens;
  }
  if (usage.cache_creation_tokens && p.cacheWriteTokens) {
    cost += (usage.cache_creation_tokens / perMillion) * p.cacheWriteTokens;
  }
  return cost;
}
