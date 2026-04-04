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

const DEFAULT_THRESHOLD = 100_000;

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

/**
 * Determine whether auto-compaction should fire. Uses usage-grounded counting
 * when a usage anchor is available, otherwise falls back to estimation.
 */
export function shouldAutoCompact(
  messages: ChatMessage[],
  config: AutoCompactConfig,
  lastUsage?: ChatCompletionUsage,
  anchorMessageIndex?: number,
): boolean {
  if (!config.enabled) return false;

  const tokens = lastUsage
    ? tokenCountWithEstimation(messages, lastUsage, anchorMessageIndex)
    : estimateMessagesTokens(messages);

  return tokens >= config.threshold;
}
