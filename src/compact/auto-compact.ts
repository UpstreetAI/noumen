import type { ChatMessage } from "../session/types.js";
import type { ChatCompletionUsage } from "../providers/types.js";
import { estimateMessagesTokens, tokenCountWithEstimation } from "../utils/tokens.js";
import { getAutoCompactThreshold } from "../utils/context.js";

export interface AutoCompactConfig {
  enabled: boolean;
  /** Token threshold at which to trigger compaction. */
  threshold: number;
  /** Number of recent messages to keep uncompacted. */
  tailMessagesToKeep?: number;
}

/**
 * Tracks consecutive auto-compact failures to implement a circuit breaker.
 * After `maxFailures` consecutive failures, auto-compact is skipped to
 * avoid an infinite fail-retry loop.
 */
export interface AutoCompactTrackingState {
  consecutiveFailures: number;
  maxFailures: number;
}

const DEFAULT_THRESHOLD = 100_000;
const DEFAULT_MAX_FAILURES = 3;

export function createAutoCompactConfig(opts?: {
  enabled?: boolean;
  threshold?: number;
  /** Model name — when provided, the threshold is computed from the model's
   *  context window instead of the fixed default.  */
  model?: string;
  maxOutputTokens?: number;
  tailMessagesToKeep?: number;
}): AutoCompactConfig {
  let threshold = opts?.threshold;
  if (threshold === undefined && opts?.model) {
    threshold = getAutoCompactThreshold(opts.model, opts.maxOutputTokens);
  }
  return {
    enabled: opts?.enabled ?? true,
    threshold: threshold ?? DEFAULT_THRESHOLD,
    tailMessagesToKeep: opts?.tailMessagesToKeep,
  };
}

export function createAutoCompactTracking(
  maxFailures?: number,
): AutoCompactTrackingState {
  return {
    consecutiveFailures: 0,
    maxFailures: maxFailures ?? DEFAULT_MAX_FAILURES,
  };
}

/**
 * Determine whether auto-compaction should fire. Uses usage-grounded counting
 * when a usage anchor is available, otherwise falls back to estimation.
 *
 * @param tokensFreed — tokens already reclaimed by microcompact/budget in
 *   this turn; subtracted from the estimate so we don't over-eagerly compact.
 */
export function shouldAutoCompact(
  messages: ChatMessage[],
  config: AutoCompactConfig,
  lastUsage?: ChatCompletionUsage,
  anchorMessageIndex?: number,
  tokensFreed?: number,
): boolean {
  if (!config.enabled) return false;

  const tokens = lastUsage
    ? tokenCountWithEstimation(messages, lastUsage, anchorMessageIndex)
    : estimateMessagesTokens(messages);

  const adjusted = tokens - (tokensFreed ?? 0);
  return adjusted >= config.threshold;
}

/**
 * Check whether the circuit breaker allows another auto-compact attempt.
 */
export function canAutoCompact(tracking: AutoCompactTrackingState): boolean {
  return tracking.consecutiveFailures < tracking.maxFailures;
}

export function recordAutoCompactSuccess(
  tracking: AutoCompactTrackingState,
): void {
  tracking.consecutiveFailures = 0;
}

export function recordAutoCompactFailure(
  tracking: AutoCompactTrackingState,
): void {
  tracking.consecutiveFailures++;
}
