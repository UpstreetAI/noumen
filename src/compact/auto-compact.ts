import type { ChatMessage } from "../session/types.js";
import { estimateMessagesTokens } from "../utils/tokens.js";

export interface AutoCompactConfig {
  enabled: boolean;
  /** Token threshold at which to trigger compaction */
  threshold: number;
}

const DEFAULT_THRESHOLD = 100_000;

export function createAutoCompactConfig(opts?: {
  enabled?: boolean;
  threshold?: number;
}): AutoCompactConfig {
  return {
    enabled: opts?.enabled ?? true,
    threshold: opts?.threshold ?? DEFAULT_THRESHOLD,
  };
}

export function shouldAutoCompact(
  messages: ChatMessage[],
  config: AutoCompactConfig,
): boolean {
  if (!config.enabled) return false;
  const tokens = estimateMessagesTokens(messages);
  return tokens >= config.threshold;
}
