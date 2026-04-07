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
  provider: AIProvider,
  model: string,
  messages: ChatMessage[],
  storage: SessionStorage,
  sessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<ReactiveCompactResult | null> {
  if (messages.length < 2) return null;
  if (opts?.signal?.aborted) {
    throw new DOMException("Compaction aborted", "AbortError");
  }

  try {
    const tailKeep = Math.min(6, messages.length - 1);
    const compacted = await compactConversation(
      provider,
      model,
      messages,
      storage,
      sessionId,
      { stripBinaryContent: true, tailMessagesToKeep: tailKeep, signal: opts?.signal },
    );
    return { messages: compacted, strategy: "compacted" };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    console.warn("[reactive-compact] compaction failed, falling back to head truncation:", err);
    const targetTokens = getEffectiveContextWindow(model);
    const truncated = truncateHeadForPTLRetry(messages, targetTokens);
    if (truncated.length === messages.length) return null;
    try {
      await storage.appendCompactBoundary(sessionId);
      const { generateUUID } = await import("../utils/uuid.js");
      const ts = new Date().toISOString();
      const entries: import("../session/types.js").Entry[] = truncated.map((msg) => ({
        type: "message" as const,
        uuid: generateUUID(),
        parentUuid: null,
        sessionId,
        timestamp: ts,
        message: msg,
      }) as import("../session/types.js").MessageEntry);
      await storage.appendEntriesBatch(sessionId, entries);
      await storage.reAppendMetadataAfterCompact(sessionId);
    } catch (persistErr) {
      console.warn("[reactive-compact] failed to persist truncation:", persistErr);
    }
    return { messages: truncated, strategy: "truncated" };
  }
}
