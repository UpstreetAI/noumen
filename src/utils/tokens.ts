import type { ChatMessage } from "../session/types.js";
import type { ChatCompletionUsage } from "../providers/types.js";

const CHARS_PER_TOKEN = 4;
const OVERHEAD_PER_MESSAGE = 4;

/**
 * Rough token estimation: ~4 chars per token for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for a single message, including role overhead.
 */
export function estimateMessageTokens(
  msg: { role: string; content: string | unknown; tool_calls?: unknown },
): number {
  let tokens = OVERHEAD_PER_MESSAGE;
  if (typeof msg.content === "string") {
    tokens += estimateTokens(msg.content);
  } else if (msg.content != null) {
    tokens += estimateTokens(JSON.stringify(msg.content));
  }
  if (msg.tool_calls) {
    tokens += estimateTokens(JSON.stringify(msg.tool_calls));
  }
  return tokens;
}

/**
 * Estimate tokens across an array of messages (pure estimation, no API anchor).
 */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string | unknown }>,
): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * Usage-grounded token counting. Uses the last API response's prompt_tokens
 * as an anchor and only estimates delta messages added since.
 *
 * If no usage anchor is available, falls back to pure estimation.
 */
export function tokenCountWithEstimation(
  messages: ChatMessage[],
  lastUsage?: ChatCompletionUsage,
  anchorMessageIndex?: number,
): number {
  if (!lastUsage || anchorMessageIndex === undefined) {
    return estimateMessagesTokens(messages);
  }

  const anchorTokens =
    lastUsage.prompt_tokens + lastUsage.completion_tokens;

  const deltaMessages = messages.slice(anchorMessageIndex + 1);
  const deltaTokens = estimateMessagesTokens(deltaMessages);

  return anchorTokens + deltaTokens;
}

/**
 * Group messages into turn groups (user -> assistant -> tool_results).
 * Each group represents one logical exchange.
 */
export function groupMessagesByTurn(
  messages: ChatMessage[],
): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let current: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(msg);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

/**
 * Drop the oldest turn groups until estimated tokens drop below `targetTokens`.
 * Returns the trimmed message list. Used for prompt-too-long recovery.
 */
export function truncateHeadForPTLRetry(
  messages: ChatMessage[],
  targetTokens: number,
): ChatMessage[] {
  const groups = groupMessagesByTurn(messages);
  if (groups.length <= 1) return messages;

  let totalEstimate = estimateMessagesTokens(messages);
  let dropCount = 0;

  while (dropCount < groups.length - 1 && totalEstimate > targetTokens) {
    totalEstimate -= estimateMessagesTokens(groups[dropCount]);
    dropCount++;
  }

  if (dropCount === 0) return messages;

  const remaining = groups.slice(dropCount).flat();

  if (remaining.length > 0 && remaining[0].role !== "user") {
    remaining.unshift({
      role: "user",
      content:
        "[Earlier conversation history was truncated to fit context window.]",
    });
  }

  return remaining;
}
