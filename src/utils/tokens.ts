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
 * Group messages into API-round groups. A new group starts at each
 * assistant boundary (after tool results) or user message. This gives
 * finer-grained groups than splitting on user messages alone, enabling
 * PTL recovery in agentic sessions with many tool-use rounds.
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

export interface PTLRetryOptions {
  /** Tokens the server reported we need to shed, or undefined if unknown. */
  tokenGap?: number;
  /** Effective context window for this model (fallback when gap unknown). */
  targetTokens: number;
}

/**
 * Drop the oldest turn groups to fit within the context window.
 *
 * If `tokenGap` is provided (parsed from the server error), use it to
 * determine exactly how many tokens to shed. Otherwise fall back to
 * dropping 20% of groups (more conservative than the heuristic target).
 */
export function truncateHeadForPTLRetry(
  messages: ChatMessage[],
  targetOrOpts: number | PTLRetryOptions,
): ChatMessage[] {
  const opts: PTLRetryOptions =
    typeof targetOrOpts === "number"
      ? { targetTokens: targetOrOpts }
      : targetOrOpts;

  const input =
    messages.length > 0 &&
    messages[0].role === "user" &&
    typeof messages[0].content === "string" &&
    messages[0].content === PTL_RETRY_MARKER
      ? messages.slice(1)
      : messages;

  const groups = groupMessagesByTurn(input);
  if (groups.length <= 1) return messages;

  let dropCount: number;

  if (opts.tokenGap !== undefined && opts.tokenGap > 0) {
    // Server told us exactly how much we're over — drop groups until we
    // shed at least that many tokens.
    let shed = 0;
    dropCount = 0;
    while (dropCount < groups.length - 1 && shed < opts.tokenGap) {
      shed += estimateMessagesTokens(groups[dropCount]);
      dropCount++;
    }
  } else {
    // Fallback: drop 20% of groups or until under target, whichever is more
    const minDrop = Math.max(1, Math.floor(groups.length * 0.2));
    let totalEstimate = estimateMessagesTokens(input);
    dropCount = 0;

    while (dropCount < groups.length - 1 && (dropCount < minDrop || totalEstimate > opts.targetTokens)) {
      totalEstimate -= estimateMessagesTokens(groups[dropCount]);
      dropCount++;
    }
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
