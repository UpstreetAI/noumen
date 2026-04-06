/**
 * Centralized message normalization for API calls.
 *
 * Ensures a ChatMessage[] is structurally valid before being sent to any
 * provider. Handles duplicate tool IDs, orphaned results, missing pairing,
 * empty assistants, consecutive same-role messages, and other corruption
 * from error/abort/compaction paths.
 *
 * Pure function: returns a new array, never mutates the input.
 */

import type {
  ChatMessage,
  AssistantMessage,
  ToolResultMessage,
  ContentPart,
} from "../session/types.js";
import { contentToString } from "../utils/content.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Normalize a message array so it is structurally valid for any LLM API.
 *
 * Transformations applied (order matters):
 *  1. Drop system messages (system prompt is a separate param)
 *  2. Deduplicate tool_use IDs across assistants
 *  3. Strip orphaned tool_results with no matching tool_use
 *  4. Deduplicate tool_results with the same tool_call_id
 *  5. Insert synthetic error results for unpaired tool_uses
 *  6. Filter whitespace-only assistant messages
 *  7. Filter orphaned thinking-only assistants
 *  8. Merge consecutive same-role messages
 *  9. Ensure every assistant has non-null content
 * 10. Strip thinking-only content from trailing assistant
 * 11. Ensure array starts with a user message
 */
export function normalizeMessagesForAPI(messages: ChatMessage[]): ChatMessage[] {
  let result = messages.slice();

  result = dropSystemMessages(result);
  result = deduplicateToolUseIds(result);
  result = stripOrphanedToolResults(result);
  result = deduplicateToolResults(result);
  result = ensureToolResultPairing(result);
  result = filterWhitespaceOnlyAssistants(result);
  result = filterOrphanedThinkingAssistants(result);
  result = mergeConsecutiveSameRole(result);
  result = ensureNonEmptyAssistantContent(result);
  result = stripTrailingThinkingOnlyAssistant(result);
  result = ensureStartsWithUser(result);

  return result;
}

// ---------------------------------------------------------------------------
// Step 1: Drop system messages
// ---------------------------------------------------------------------------

function dropSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role !== "system");
}

// ---------------------------------------------------------------------------
// Step 2: Deduplicate tool_use IDs
// ---------------------------------------------------------------------------

/**
 * Strip duplicate tool_call IDs from later assistant messages. If a
 * tool_call.id appears in an earlier assistant, it is removed from the
 * later one. If stripping empties the assistant's tool_calls array and
 * it has no text content, the assistant is dropped entirely.
 *
 * Also removes any tool result messages that reference stripped IDs.
 */
function deduplicateToolUseIds(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const strippedIds = new Set<string>();
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const asst = msg as AssistantMessage;
      if (asst.tool_calls && asst.tool_calls.length > 0) {
        const kept = asst.tool_calls.filter((tc) => {
          if (seen.has(tc.id)) {
            strippedIds.add(tc.id);
            return false;
          }
          seen.add(tc.id);
          return true;
        });

        if (kept.length === 0) {
          const text = asst.content != null ? contentToString(asst.content) : "";
          if (text.trim() === "") continue; // drop entirely
          result.push({ ...asst, tool_calls: undefined } as AssistantMessage);
        } else if (kept.length < asst.tool_calls.length) {
          result.push({ ...asst, tool_calls: kept });
        } else {
          result.push(msg);
        }
      } else {
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  if (strippedIds.size === 0) return result;

  return result.filter((msg) => {
    if (msg.role !== "tool") return true;
    return !strippedIds.has((msg as ToolResultMessage).tool_call_id);
  });
}

// ---------------------------------------------------------------------------
// Step 3: Strip orphaned tool_results
// ---------------------------------------------------------------------------

/**
 * Remove tool result messages whose tool_call_id does not match any
 * tool_call in a preceding assistant message.
 */
function stripOrphanedToolResults(messages: ChatMessage[]): ChatMessage[] {
  const knownCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const asst = msg as AssistantMessage;
      if (asst.tool_calls) {
        for (const tc of asst.tool_calls) {
          knownCallIds.add(tc.id);
        }
      }
    }
  }

  return messages.filter((msg) => {
    if (msg.role !== "tool") return true;
    return knownCallIds.has((msg as ToolResultMessage).tool_call_id);
  });
}

// ---------------------------------------------------------------------------
// Step 4: Deduplicate tool_results
// ---------------------------------------------------------------------------

/**
 * Keep only the first tool result for each tool_call_id. Duplicates can
 * appear after crash recovery or corrupted session transcripts.
 */
function deduplicateToolResults(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.filter((msg) => {
    if (msg.role !== "tool") return true;
    const id = (msg as ToolResultMessage).tool_call_id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Step 5: Ensure tool result pairing
// ---------------------------------------------------------------------------

/**
 * Insert synthetic error results for any assistant tool_calls that have
 * no matching tool result in the conversation.
 *
 * Synthetic results are inserted after the last real tool result for the
 * assistant's calls, or immediately after the assistant if none exist.
 */
export function ensureToolResultPairing(messages: ChatMessage[]): ChatMessage[] {
  const resolvedIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool") {
      resolvedIds.add((msg as ToolResultMessage).tool_call_id);
    }
  }

  const insertions = new Map<number, ToolResultMessage[]>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const asst = msg as AssistantMessage;
    if (!asst.tool_calls || asst.tool_calls.length === 0) continue;

    const missing = asst.tool_calls.filter((tc) => !resolvedIds.has(tc.id));
    if (missing.length === 0) continue;

    const allCallIds = new Set(asst.tool_calls.map((tc) => tc.id));
    let insertAfter = i;
    for (let j = i + 1; j < messages.length; j++) {
      if (
        messages[j].role === "tool" &&
        allCallIds.has((messages[j] as ToolResultMessage).tool_call_id)
      ) {
        insertAfter = j;
      }
    }

    const synthetics: ToolResultMessage[] = missing.map((tc) => ({
      role: "tool" as const,
      tool_call_id: tc.id,
      content:
        "Error: Tool result missing — session was interrupted before this tool completed.",
      isError: true,
    }));

    const existing = insertions.get(insertAfter);
    if (existing) {
      existing.push(...synthetics);
    } else {
      insertions.set(insertAfter, synthetics);
    }
  }

  if (insertions.size === 0) return messages;

  const result: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    result.push(messages[i]);
    const toInsert = insertions.get(i);
    if (toInsert) result.push(...toInsert);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 5: Filter whitespace-only assistants
// ---------------------------------------------------------------------------

/**
 * Drop assistant messages with no tool_calls and empty/whitespace-only
 * content. These are API-invalid.
 */
export function filterWhitespaceOnlyAssistants(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const asst = msg as AssistantMessage;
    if (asst.tool_calls && asst.tool_calls.length > 0) return true;
    if (asst.thinking_content) return true;
    const text =
      typeof asst.content === "string"
        ? asst.content
        : contentToString(asst.content ?? "");
    return text.trim() !== "";
  });
}

// ---------------------------------------------------------------------------
// Step 6: Filter orphaned thinking-only assistants
// ---------------------------------------------------------------------------

/**
 * Drop assistants with null/undefined content and no tool_calls.
 * These are artifacts of streaming interruptions where only thinking
 * was streamed before the connection broke.
 */
export function filterOrphanedThinkingAssistants(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const asst = msg as AssistantMessage;
    if (asst.tool_calls && asst.tool_calls.length > 0) return true;
    return asst.content !== null && asst.content !== undefined;
  });
}

// ---------------------------------------------------------------------------
// Step 7: Merge consecutive same-role messages
// ---------------------------------------------------------------------------

/**
 * Merge adjacent messages with the same role. This restores valid role
 * alternation after filters remove messages from the middle.
 *
 * - User messages: content parts are concatenated.
 * - Assistant messages: text is joined with newline, tool_calls and
 *   thinking fields are merged.
 * - Tool messages are never merged (they belong to specific tool_call IDs).
 */
export function mergeConsecutiveSameRole(
  messages: ChatMessage[],
): ChatMessage[] {
  if (messages.length <= 1) return messages;

  const result: ChatMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (prev.role === "user" && curr.role === "user") {
      const prevParts = toContentParts(prev.content as string | ContentPart[]);
      const currParts = toContentParts(curr.content as string | ContentPart[]);
      result[result.length - 1] = {
        role: "user",
        content: [...prevParts, ...currParts],
      };
    } else if (prev.role === "assistant" && curr.role === "assistant") {
      result[result.length - 1] = mergeAssistantPair(
        prev as AssistantMessage,
        curr as AssistantMessage,
      );
    } else {
      result.push(curr);
    }
  }

  return result;
}

function mergeAssistantPair(
  prev: AssistantMessage,
  curr: AssistantMessage,
): AssistantMessage {
  const prevText = assistantTextContent(prev);
  const currText = assistantTextContent(curr);
  const mergedContent =
    prevText || currText
      ? prevText + (currText ? "\n" + currText : "")
      : null;
  const mergedToolCalls = [
    ...(prev.tool_calls ?? []),
    ...(curr.tool_calls ?? []),
  ];
  const mergedThinking =
    [prev.thinking_content, curr.thinking_content]
      .filter(Boolean)
      .join("\n") || undefined;

  return {
    role: "assistant",
    content: mergedContent,
    ...(mergedToolCalls.length > 0 ? { tool_calls: mergedToolCalls } : {}),
    ...(mergedThinking ? { thinking_content: mergedThinking } : {}),
    ...(curr.thinking_signature ?? prev.thinking_signature
      ? {
          thinking_signature:
            curr.thinking_signature ?? prev.thinking_signature,
        }
      : {}),
    ...(curr.redacted_thinking_data ?? prev.redacted_thinking_data
      ? {
          redacted_thinking_data:
            curr.redacted_thinking_data ?? prev.redacted_thinking_data,
        }
      : {}),
  } as AssistantMessage;
}

// ---------------------------------------------------------------------------
// Step 8: Ensure non-empty assistant content
// ---------------------------------------------------------------------------

/**
 * Providers may reject assistants with `content: null`. If the assistant
 * has tool_calls (or survived all prior filters), set content to `""`.
 */
function ensureNonEmptyAssistantContent(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const asst = msg as AssistantMessage;
    if (asst.content === null || asst.content === undefined) {
      return { ...asst, content: "" };
    }
    return msg;
  });
}

// ---------------------------------------------------------------------------
// Step 10: Strip thinking-only trailing assistant
// ---------------------------------------------------------------------------

/**
 * If the last message is an assistant with only thinking content (no
 * substantive text and no tool_calls), strip the thinking fields. The
 * Anthropic API rejects messages where thinking blocks are the sole
 * content in the final assistant turn.
 */
function stripTrailingThinkingOnlyAssistant(
  messages: ChatMessage[],
): ChatMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return messages;
  const asst = last as AssistantMessage;
  if (asst.tool_calls && asst.tool_calls.length > 0) return messages;
  if (!asst.thinking_content) return messages;
  const text =
    typeof asst.content === "string"
      ? asst.content
      : contentToString(asst.content ?? "");
  if (text.trim() !== "") return messages;
  return messages.slice(0, -1);
}

// ---------------------------------------------------------------------------
// Step 11: Ensure starts with user
// ---------------------------------------------------------------------------

/**
 * The Anthropic API requires the first message to be a user message.
 * Other providers are lenient but a leading user message is always safe.
 */
function ensureStartsWithUser(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) {
    return [{ role: "user", content: "[Conversation resumed]" }];
  }
  if (messages[0].role !== "user") {
    return [
      { role: "user", content: "[Conversation resumed]" } as ChatMessage,
      ...messages,
    ];
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toContentParts(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) return content;
  return [{ type: "text", text: contentToString(content) }];
}

function assistantTextContent(asst: AssistantMessage): string {
  if (typeof asst.content === "string") return asst.content;
  if (Array.isArray(asst.content)) {
    return contentToString(asst.content as ContentPart[]);
  }
  return "";
}
