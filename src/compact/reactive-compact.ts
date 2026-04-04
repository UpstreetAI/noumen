import type { AIProvider } from "../providers/types.js";
import type { ChatMessage } from "../session/types.js";
import type { SessionStorage } from "../session/storage.js";
import { compactConversation } from "./compact.js";
import { truncateHeadForPTLRetry } from "../utils/tokens.js";
import { getEffectiveContextWindow } from "../utils/context.js";

export interface ReactiveCompactConfig {
  enabled: boolean;
}

export interface ReactiveCompactResult {
  messages: ChatMessage[];
  strategy: "compacted" | "truncated";
}

/**
 * Attempt to recover from a context-overflow error by compacting the
 * conversation. If compaction itself fails (e.g. the context is so large
 * that even the summarizer cannot run), falls back to
 * {@link truncateHeadForPTLRetry} which drops the oldest turn groups
 * until the estimate fits within the target.
 *
 * Returns `null` if there are not enough messages to meaningfully compact
 * or truncate (less than 2 messages).
 */
export async function tryReactiveCompact(
  aiProvider: AIProvider,
  model: string,
  messages: ChatMessage[],
  storage: SessionStorage,
  sessionId: string,
): Promise<ReactiveCompactResult | null> {
  if (messages.length < 2) return null;

  try {
    const compacted = await compactConversation(
      aiProvider,
      model,
      messages,
      storage,
      sessionId,
      { stripBinaryContent: true },
    );
    return { messages: compacted, strategy: "compacted" };
  } catch {
    // Compaction failed — fall back to head truncation
    const targetTokens = getEffectiveContextWindow(model);
    const truncated = truncateHeadForPTLRetry(messages, targetTokens);
    if (truncated.length === messages.length) return null;
    return { messages: truncated, strategy: "truncated" };
  }
}
