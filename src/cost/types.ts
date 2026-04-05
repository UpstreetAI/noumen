/**
 * USD cost per 1 million tokens for a given model.
 */
export interface ModelPricing {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Token usage from a single API call, extending the base ChatCompletionUsage
 * with cache and thinking token counts.
 */
export interface UsageRecord {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  thinking_tokens?: number;
}

/**
 * Accumulated usage and cost for a single model.
 */
export interface ModelUsageSummary {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
}

/**
 * Complete cost summary across all models in the session.
 */
export interface CostSummary {
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  byModel: Record<string, ModelUsageSummary>;
  duration: {
    apiMs: number;
    wallMs: number;
  };
}
