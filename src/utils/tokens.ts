import type { ChatMessage, ContentPart, ImageContent } from "../session/types.js";
import type { ChatCompletionUsage } from "../providers/types.js";

const CHARS_PER_TOKEN = 4;
const OVERHEAD_PER_MESSAGE = 4;
/** Minimum token cost for an image (URL-only images with no base64 data). */
const MIN_TOKENS_PER_IMAGE = 85;

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
  msg: { role: string; content: string | ContentPart[] | unknown; tool_calls?: unknown },
): number {
  let tokens = OVERHEAD_PER_MESSAGE;
  if (typeof msg.content === "string") {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content as ContentPart[]) {
      if (part.type === "text") {
        tokens += estimateTokens(part.text);
      } else if (part.type === "image" && (part as ImageContent).data) {
        // base64 chars × 0.125 gives accurate token estimate
        tokens += Math.max(
          MIN_TOKENS_PER_IMAGE,
          Math.ceil((part as ImageContent).data.length * 0.125),
        );
      } else {
        tokens += MIN_TOKENS_PER_IMAGE;
      }
    }
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

  const anchorTokens = lastUsage.prompt_tokens;

  const deltaMessages = messages.slice(anchorMessageIndex + 1);
  const deltaTokens = estimateMessagesTokens(deltaMessages);

  return anchorTokens + deltaTokens;
}

/**
 * Group messages into API-round groups. A new group starts when an
 * assistant message follows a tool result (i.e. each model response
 * round). This gives finer-grained groups than splitting on user
 * messages, enabling PTL recovery in agentic sessions with many
 * tool-use rounds under a single user prompt.
 */
export function groupMessagesByTurn(
  messages: ChatMessage[],
): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let prevRole: string | undefined;

  for (const msg of messages) {
    if (msg.role === "assistant" && prevRole === "tool" && current.length > 0) {
      groups.push(current);
      current = [];
    } else if (msg.role === "user" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(msg);
    prevRole = msg.role;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

const PTL_RETRY_MARKER =
  "[Earlier conversation history was truncated to fit context window.]";

/**
 * Drop the oldest turn groups until estimated tokens drop below `targetTokens`.
 * Returns the trimmed message list. Used for prompt-too-long recovery.
 */
export function truncateHeadForPTLRetry(
  messages: ChatMessage[],
  targetTokens: number,
): ChatMessage[] {
  const input =
    messages.length > 0 &&
    messages[0].role === "user" &&
    typeof messages[0].content === "string" &&
    messages[0].content === PTL_RETRY_MARKER
      ? messages.slice(1)
      : messages;

  const groups = groupMessagesByTurn(input);
  if (groups.length <= 1) return messages;

  let totalEstimate = estimateMessagesTokens(input);
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
      content: PTL_RETRY_MARKER,
    });
  }

  return remaining;
}
