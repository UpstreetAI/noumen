import type { StreamEvent } from "../session/types.js";

export interface RetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableStatuses?: number[];
  fallbackModel?: string;
  /** Max consecutive overloaded (529) errors before triggering model fallback. */
  maxConsecutiveOverloaded?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 10,
  baseDelayMs: 500,
  maxDelayMs: 32000,
  retryableStatuses: [408, 409, 429, 500, 502, 503, 529],
  maxConsecutiveOverloaded: 3,
};

export interface RetryEngineOptions extends RetryConfig {
  model: string;
  thinkingBudget?: number;
  signal?: AbortSignal;
}

export interface RetryContext {
  attempt: number;
  model: string;
  maxTokensOverride?: number;
}

export type RetryEvent = Extract<StreamEvent, { type: "retry_attempt" | "retry_exhausted" }>;
