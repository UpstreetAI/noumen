import type { AIProvider, ChatParams } from "../providers/types.js";
import type { ChatMessage, AssistantMessage, ContentPart } from "../session/types.js";
import type { SessionStorage } from "../session/storage.js";
import { estimateMessagesTokens } from "../utils/tokens.js";
import { contentToString, hasImageContent, stripImageContent } from "../utils/content.js";
import { truncateHeadForPTLRetry } from "../utils/tokens.js";
import { getEffectiveContextWindow } from "../utils/context.js";
import { classifyError } from "../retry/classify.js";
import { mergeConsecutiveSameRole } from "../messages/normalize.js";

const COMPACT_SYSTEM_PROMPT = `You are a helpful AI assistant tasked with summarizing conversations. 
Create a concise but comprehensive summary of the conversation so far. 
Preserve all important technical details, decisions made, file paths mentioned, 
code changes discussed, and any pending tasks or context that would be needed 
to continue the conversation effectively.

Format your summary as a structured overview that covers:
1. What was accomplished
2. Key technical details and decisions
3. Current state (what files were modified, what's working/broken)
4. Any pending tasks or next steps discussed`;

export interface CompactOptions {
  customInstructions?: string;
  /** Number of recent messages to keep uncompacted (default: 0 = summarize all). */
  tailMessagesToKeep?: number;
  /** Strip binary/image content from messages before sending to the summarizer. */
  stripBinaryContent?: boolean;
  /** Abort signal — if fired, the partial summary is discarded instead of persisted. */
  signal?: AbortSignal;
}

export async function compactConversation(
  provider: AIProvider,
  model: string,
  messages: ChatMessage[],
  storage: SessionStorage,
  sessionId: string,
  opts?: CompactOptions,
): Promise<ChatMessage[]> {
  const tailCount = opts?.tailMessagesToKeep ?? 0;
  const stripBinary = opts?.stripBinaryContent ?? true;

  let splitIdx = tailCount > 0
    ? Math.max(0, messages.length - tailCount)
    : messages.length;

  // Adjust split point to avoid orphaning tool_use/tool_result pairs.
  // Walk backward to find a safe boundary that doesn't land between an
  // assistant with tool_calls and the corresponding tool result messages.
  splitIdx = adjustSplitForToolPairs(messages, splitIdx);

  const toSummarize = messages.slice(0, splitIdx);
  const tail = messages.slice(splitIdx);

  if (toSummarize.length === 0) return messages;

  const cleanedMessages = stripBinary
    ? stripBinaryFromMessages(toSummarize)
    : toSummarize;

  const summaryPrompt =
    opts?.customInstructions ??
    "Please summarize the conversation above concisely but thoroughly.";

  const MAX_PTL_RETRIES = 3;
  let currentToSummarize = cleanedMessages;
  let summaryText = "";

  for (let ptlAttempt = 0; ptlAttempt <= MAX_PTL_RETRIES; ptlAttempt++) {
    summaryText = "";
    const attemptMessages: ChatMessage[] = [
      ...currentToSummarize,
      { role: "user", content: summaryPrompt },
    ];
    const attemptParams: ChatParams = {
      model,
      messages: attemptMessages,
      system: COMPACT_SYSTEM_PROMPT,
      max_tokens: 4096,
    };

    try {
      for await (const chunk of provider.chat(attemptParams)) {
        if (opts?.signal?.aborted) {
          throw new DOMException("Compaction aborted", "AbortError");
        }
        for (const choice of chunk.choices) {
          if (choice.delta.content) {
            summaryText += choice.delta.content;
          }
        }
      }
      break; // Success
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      const classification = classifyError(err);
      if (!classification.isContextOverflow || ptlAttempt >= MAX_PTL_RETRIES) {
        throw err;
      }
      const targetTokens = getEffectiveContextWindow(model);
      const truncated = truncateHeadForPTLRetry(currentToSummarize, targetTokens);
      if (truncated.length >= currentToSummarize.length || truncated.length === 0) {
        throw err;
      }
      currentToSummarize = truncated;
    }
  }

  if (opts?.signal?.aborted) {
    throw new DOMException("Compaction aborted", "AbortError");
  }

  if (!summaryText.trim()) {
    throw new Error("Compaction produced an empty summary — aborting to prevent context loss");
  }

  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[Conversation Summary]\n\n${summaryText}`,
  };
  // Write boundary first, then summary + tail + metadata atomically in a
  // single batch write. This prevents partial tail loss on crash — either
  // all post-boundary entries are written or none are.
  // The orphaned-boundary validator in loadMessages handles the case where
  // we crash between the boundary write and the batch write.
  await storage.appendCompactBoundary(sessionId);

  const { generateUUID } = await import("../utils/uuid.js");
  const batchEntries: import("../session/types.js").Entry[] = [];
  const ts = new Date().toISOString();

  batchEntries.push({
    type: "summary",
    uuid: generateUUID(),
    parentUuid: null,
    sessionId,
    timestamp: ts,
    message: summaryMessage,
  } as import("../session/types.js").SummaryEntry);

  for (const msg of tail) {
    batchEntries.push({
      type: "message",
      uuid: generateUUID(),
      parentUuid: null,
      sessionId,
      timestamp: ts,
      message: msg,
    } as import("../session/types.js").MessageEntry);
  }

  await storage.appendEntriesBatch(sessionId, batchEntries);

  await storage.reAppendMetadataAfterCompact(sessionId);

  // Ensure role alternation is valid after inserting the summary
  const merged = mergeConsecutiveSameRole([summaryMessage, ...tail]);
  return merged;
}

/**
 * Estimate the token savings from a potential compaction.
 */
export function estimateCompactionSavings(
  messages: ChatMessage[],
  tailMessagesToKeep: number,
): { currentTokens: number; estimatedAfter: number } {
  const currentTokens = estimateMessagesTokens(messages);
  const splitIdx = Math.max(0, messages.length - tailMessagesToKeep);
  const tail = messages.slice(splitIdx);
  const tailTokens = estimateMessagesTokens(tail);
  const estimatedSummary = 10_000;
  return {
    currentTokens,
    estimatedAfter: tailTokens + estimatedSummary,
  };
}

const BINARY_PATTERN = /^data:[a-z]+\/[a-z+.-]+;base64,/i;
const LONG_HEX_PATTERN = /^[0-9a-f]{256,}$/i;

function stripBinaryFromMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    // Handle array content (can contain images in tool results)
    if (Array.isArray(msg.content)) {
      const parts = msg.content as ContentPart[];
      let hasMedia = false;
      const cleaned = parts.map((part) => {
        if (part.type === "image") {
          hasMedia = true;
          return { type: "text" as const, text: "[image removed for summarization]" };
        }
        return part;
      });
      if (hasMedia) {
        return { ...msg, content: cleaned } as ChatMessage;
      }
    }

    if (hasImageContent(msg.content as string | ContentPart[])) {
      return {
        ...msg,
        content: stripImageContent(
          msg.content as string | ContentPart[],
          "[image removed for summarization]",
        ),
      } as ChatMessage;
    }
    const text = contentToString(msg.content as string | ContentPart[]);
    if (BINARY_PATTERN.test(text) || LONG_HEX_PATTERN.test(text)) {
      return { ...msg, content: "[binary content removed for summarization]" } as ChatMessage;
    }
    if (text.length > 50_000) {
      return {
        ...msg,
        content:
          text.slice(0, 25_000) +
          "\n...[content truncated for summarization]...\n" +
          text.slice(-5_000),
      } as ChatMessage;
    }
    return msg;
  });
}

/**
 * Adjust splitIdx so it doesn't land between an assistant's tool_calls
 * and their corresponding tool result messages. If the current split
 * would orphan tool results, walk backward to just before the assistant.
 */
export function adjustSplitForToolPairs(messages: ChatMessage[], splitIdx: number): number {
  if (splitIdx <= 0 || splitIdx >= messages.length) return splitIdx;

  // If the message at splitIdx is a tool result, the preceding assistant's
  // tool_calls would be in the summarized portion while results are in the tail.
  // Walk backward past all consecutive tool results and their parent assistant.
  let idx = splitIdx;
  while (idx > 0 && messages[idx]?.role === "tool") {
    idx--;
  }
  // If we walked back to an assistant with tool_calls, include it in the tail
  if (idx < splitIdx && idx >= 0 && messages[idx]?.role === "assistant") {
    const asst = messages[idx] as AssistantMessage;
    if (asst.tool_calls && asst.tool_calls.length > 0) {
      return idx;
    }
  }

  return splitIdx;
}

// mergeConsecutiveSameRole is imported from "../messages/normalize.js" above.
