import type { AIProvider, ChatParams } from "../providers/types.js";
import type { ChatMessage, ContentPart } from "../session/types.js";
import type { SessionStorage } from "../session/storage.js";
import { estimateMessagesTokens } from "../utils/tokens.js";
import { contentToString, hasImageContent, stripImageContent } from "../utils/content.js";

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
  aiProvider: AIProvider,
  model: string,
  messages: ChatMessage[],
  storage: SessionStorage,
  sessionId: string,
  opts?: CompactOptions,
): Promise<ChatMessage[]> {
  const tailCount = opts?.tailMessagesToKeep ?? 0;
  const stripBinary = opts?.stripBinaryContent ?? true;

  const splitIdx = tailCount > 0
    ? Math.max(0, messages.length - tailCount)
    : messages.length;

  const toSummarize = messages.slice(0, splitIdx);
  const tail = messages.slice(splitIdx);

  if (toSummarize.length === 0) return messages;

  const cleanedMessages = stripBinary
    ? stripBinaryFromMessages(toSummarize)
    : toSummarize;

  const summaryPrompt =
    opts?.customInstructions ??
    "Please summarize the conversation above concisely but thoroughly.";

  const compactMessages: ChatMessage[] = [
    ...cleanedMessages,
    { role: "user", content: summaryPrompt },
  ];

  const params: ChatParams = {
    model,
    messages: compactMessages,
    system: COMPACT_SYSTEM_PROMPT,
    max_tokens: 4096,
  };

  let summaryText = "";
  for await (const chunk of aiProvider.chat(params)) {
    if (opts?.signal?.aborted) {
      throw new DOMException("Compaction aborted", "AbortError");
    }
    for (const choice of chunk.choices) {
      if (choice.delta.content) {
        summaryText += choice.delta.content;
      }
    }
  }

  if (opts?.signal?.aborted) {
    throw new DOMException("Compaction aborted", "AbortError");
  }

  await storage.appendCompactBoundary(sessionId);
  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[Conversation Summary]\n\n${summaryText}`,
  };
  await storage.appendSummary(sessionId, summaryMessage);

  return [summaryMessage, ...tail];
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
