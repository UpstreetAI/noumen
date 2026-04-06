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
import { normalizeToolInputsInMessages } from "./tool-input-normalize.js";

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
 *  6. Filter orphaned thinking-only assistants (null/undefined content)
 *  7. Filter whitespace-only assistant messages
 *  8. Merge consecutive same-role messages
 *  9. Ensure every assistant has non-null content
 * 10. Strip thinking-only trailing assistant (after merge — merge can
 *     create new trailing messages with only thinking content)
 * 11. Ensure array starts with a user message
 */
export function normalizeMessagesForAPI(messages: ChatMessage[]): ChatMessage[] {
  let result = messages.slice();

  result = dropSystemMessages(result);
  result = deduplicateToolUseIds(result);
  result = stripOrphanedToolResults(result);
  result = deduplicateToolResults(result);
  result = ensureToolResultPairing(result);
  result = sanitizeErrorToolResultContent(result);
  result = reorderToolResultsAfterAssistant(result);
  result = filterOrphanedThinkingAssistants(result);
  result = filterWhitespaceOnlyAssistants(result);
  result = mergeAssistantsByTurnId(result);
  result = mergeConsecutiveSameRole(result);
  result = ensureNonEmptyAssistantContent(result);
  result = stripTrailingThinkingOnlyAssistant(result);
  result = stripStaleSignatureBlocks(result);
  result = validateImagesForAPI(result);
  result = ensureStartsWithUser(result);
  result = stripInternalFields(result);
  result = normalizeToolInputsInMessages(result);

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
  let changed = false;
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const asst = msg as AssistantMessage;
      if (asst.tool_calls && asst.tool_calls.length > 0) {
        const kept = asst.tool_calls.filter((tc) => {
          if (seen.has(tc.id)) return false;
          seen.add(tc.id);
          return true;
        });

        if (kept.length < asst.tool_calls.length) {
          changed = true;
          if (kept.length === 0) {
            const text = asst.content != null ? contentToString(asst.content) : "";
            if (text.trim() === "") continue;
            result.push({ ...asst, tool_calls: undefined } as AssistantMessage);
          } else {
            result.push({ ...asst, tool_calls: kept });
          }
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

  return changed ? result : messages;
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

  // Strict fallback: drop assistants whose tool_calls are ALL unresolved
  // and that have no meaningful text content. The context is clearly
  // truncated and synthetic results would add noise, not value.
  const dropIndices = new Set<number>();
  const dropCallIds = new Set<string>();
  const insertions = new Map<number, ToolResultMessage[]>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const asst = msg as AssistantMessage;
    if (!asst.tool_calls || asst.tool_calls.length === 0) continue;

    const missing = asst.tool_calls.filter((tc) => !resolvedIds.has(tc.id));
    if (missing.length === 0) continue;

    // If ALL calls are unresolved and text content is empty, drop entirely
    if (missing.length === asst.tool_calls.length) {
      const text = asst.content != null ? contentToString(asst.content) : "";
      if (text.trim() === "") {
        dropIndices.add(i);
        for (const tc of asst.tool_calls) dropCallIds.add(tc.id);
        continue;
      }
    }

    // Partial resolution: insert synthetic errors for missing results
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

  if (insertions.size === 0 && dropIndices.size === 0) return messages;

  const result: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (dropIndices.has(i)) continue;
    if (messages[i].role === "tool" && dropCallIds.has((messages[i] as ToolResultMessage).tool_call_id)) continue;
    result.push(messages[i]);
    const toInsert = insertions.get(i);
    if (toInsert) result.push(...toInsert);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 5b: Sanitize error tool result content
// ---------------------------------------------------------------------------

/**
 * The API rejects tool_results with `isError: true` that contain non-text
 * content (images, etc.). Strip non-text parts and keep only text, joining
 * multiple text segments. Avoids permanent 400s from resumed sessions that
 * persisted images in error results.
 */
function sanitizeErrorToolResultContent(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const result = messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const tr = msg as ToolResultMessage;
    if (!tr.isError) return msg;
    if (!Array.isArray(tr.content)) return msg;
    if (tr.content.every((c) => c.type === "text")) return msg;

    changed = true;
    const texts = tr.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    return {
      ...tr,
      content: texts.length > 0 ? texts.join("\n\n") : "Error (details unavailable)",
    } as ToolResultMessage;
  });
  return changed ? result : messages;
}

// ---------------------------------------------------------------------------
// Step 5c: Reorder tool results to follow their owning assistant
// ---------------------------------------------------------------------------

/**
 * Ensure every tool result appears in the contiguous block after its owning
 * assistant. Corrupt transcripts (crash recovery, bad session merge) can
 * have user messages or other non-tool rows between an assistant and its
 * results. This step moves displaced tool results back to the correct
 * position without dropping any data.
 */
function reorderToolResultsAfterAssistant(
  messages: ChatMessage[],
): ChatMessage[] {
  // Build a map: tool_call_id → index of the owning assistant
  const ownerIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "assistant") continue;
    const asst = messages[i] as AssistantMessage;
    if (!asst.tool_calls) continue;
    for (const tc of asst.tool_calls) {
      ownerIdx.set(tc.id, i);
    }
  }

  // Check if any tool results are displaced (separated from assistant by non-tool)
  let needsReorder = false;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "tool") continue;
    const callId = (messages[i] as ToolResultMessage).tool_call_id;
    const asstIdx = ownerIdx.get(callId);
    if (asstIdx === undefined) continue;
    for (let j = asstIdx + 1; j < i; j++) {
      if (messages[j].role === "user") {
        needsReorder = true;
        break;
      }
    }
    if (needsReorder) break;
  }
  if (!needsReorder) return messages;

  // Rebuild: for each assistant with tool_calls, collect its results and
  // place them immediately after the assistant, then emit remaining messages.
  const consumed = new Set<number>();
  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (consumed.has(i)) continue;
    result.push(messages[i]);

    if (messages[i].role !== "assistant") continue;
    const asst = messages[i] as AssistantMessage;
    if (!asst.tool_calls || asst.tool_calls.length === 0) continue;

    const callIds = new Set(asst.tool_calls.map((tc) => tc.id));
    // Gather all tool results for this assistant (in original order)
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role !== "tool") continue;
      if (!callIds.has((messages[j] as ToolResultMessage).tool_call_id)) continue;
      if (!consumed.has(j)) {
        consumed.add(j);
        result.push(messages[j]);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 7: Filter whitespace-only assistants
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
// (runs before whitespace filter so null-content artifacts are removed first)
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
// Step 8a: Merge non-adjacent assistants with the same _turnId
// ---------------------------------------------------------------------------

/**
 * When streaming produces split assistant chunks separated by tool result
 * rows (all belonging to the same provider response), merge them back
 * together. This mirrors claude-code's merge-by-message.id logic.
 *
 * The merge walks backward from each assistant, across intervening tool
 * result rows, looking for an earlier assistant with the same `_turnId`.
 */
function mergeAssistantsByTurnId(messages: ChatMessage[]): ChatMessage[] {
  const hasTurnIds = messages.some(
    (m) => m.role === "assistant" && (m as AssistantMessage)._turnId != null,
  );
  if (!hasTurnIds) return messages;

  const result: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      result.push(msg);
      continue;
    }
    const asst = msg as AssistantMessage;
    if (!asst._turnId) {
      result.push(msg);
      continue;
    }

    // Walk backward through result, skipping tool results and
    // assistants with different _turnIds, to find a match.
    let merged = false;
    for (let i = result.length - 1; i >= 0; i--) {
      const prev = result[i];
      if (prev.role === "tool") continue;
      if (prev.role !== "assistant") break;
      const prevAsst = prev as AssistantMessage;
      if (prevAsst._turnId === asst._turnId) {
        result[i] = mergeAssistantPair(prevAsst, asst);
        merged = true;
        break;
      }
      // Different assistant — keep looking only if it also has a _turnId
      if (!prevAsst._turnId) break;
    }
    if (!merged) {
      result.push(msg);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 8b: Merge consecutive same-role messages
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
    ...(prev._turnId ?? curr._turnId
      ? { _turnId: prev._turnId ?? curr._turnId }
      : {}),
  } as AssistantMessage;
}

// ---------------------------------------------------------------------------
// Step 9: Ensure non-empty assistant content
// ---------------------------------------------------------------------------

/**
 * Providers reject assistants with `content: null`.
 *
 * - Non-final assistants: set null/undefined content to `""`.
 * - Final assistant: also set to `""` — enables prefill/continuation;
 *   an empty string is accepted by all providers (unlike `null`).
 */
function ensureNonEmptyAssistantContent(
  messages: ChatMessage[],
): ChatMessage[] {
  let changed = false;
  const result = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const asst = msg as AssistantMessage;
    if (asst.content === null || asst.content === undefined) {
      changed = true;
      return { ...asst, content: "" };
    }
    return msg;
  });
  return changed ? result : messages;
}

// ---------------------------------------------------------------------------
// Step 10: Strip thinking-only trailing assistant
// (runs after merge — mergeConsecutiveSameRole can create new trailing
// assistants with only thinking content that need to be removed)
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

// ---------------------------------------------------------------------------
// Step 10b: Strip stale thinking signatures from non-final assistants
// ---------------------------------------------------------------------------

/**
 * thinking_signature and redacted_thinking_data are model-bound: replaying
 * them to a different model causes API 400s. After a model switch or across
 * compaction boundaries, these fields on older messages become stale.
 *
 * Only the final assistant's signature is potentially valid (belongs to
 * the current turn). All earlier signatures are stripped.
 */
function stripStaleSignatureBlocks(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;

  let changed = false;
  const result = messages.map((msg, i) => {
    if (msg.role !== "assistant") return msg;
    const asst = msg as AssistantMessage;
    const isLast = i === messages.length - 1;
    if (isLast) return msg;

    if (asst.thinking_signature || asst.redacted_thinking_data) {
      changed = true;
      const {
        thinking_signature: _sig,
        redacted_thinking_data: _red,
        ...rest
      } = asst;
      return rest as AssistantMessage;
    }
    return msg;
  });
  return changed ? result : messages;
}

// ---------------------------------------------------------------------------
// Step 10c: Validate images for API
// ---------------------------------------------------------------------------

const MAX_IMAGES_PER_REQUEST = 20;
const MAX_IMAGE_BASE64_SIZE = 5 * 1024 * 1024; // 5 MB
const VALID_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

/**
 * Strip oversized or invalid images from messages to prevent API rejections.
 * Providers impose limits on image count, size, and format.
 */
function validateImagesForAPI(messages: ChatMessage[]): ChatMessage[] {
  let imageCount = 0;
  let changed = false;

  const result = messages.map((msg) => {
    if (msg.role === "assistant") return msg;
    const content = (msg as { content: string | ContentPart[] }).content;
    if (!Array.isArray(content)) return msg;

    let msgChanged = false;
    const validated = content.map((part) => {
      if (part.type !== "image") return part;

      imageCount++;

      if (imageCount > MAX_IMAGES_PER_REQUEST) {
        msgChanged = true;
        return {
          type: "text" as const,
          text: "[image removed — too many images in this request]",
        };
      }

      if (part.data && part.data.length > MAX_IMAGE_BASE64_SIZE) {
        msgChanged = true;
        return {
          type: "text" as const,
          text: `[image removed — exceeds ${MAX_IMAGE_BASE64_SIZE / 1024 / 1024}MB size limit]`,
        };
      }

      if (
        part.media_type &&
        !VALID_IMAGE_MEDIA_TYPES.has(part.media_type)
      ) {
        msgChanged = true;
        return {
          type: "text" as const,
          text: `[image removed — unsupported format: ${part.media_type}]`,
        };
      }

      return part;
    });

    if (msgChanged) {
      changed = true;
      return { ...msg, content: validated } as ChatMessage;
    }
    return msg;
  });

  return changed ? result : messages;
}

// ---------------------------------------------------------------------------
// Final: Strip internal metadata fields before sending to providers
// ---------------------------------------------------------------------------

/**
 * Remove internal-only fields (like `_turnId`) that providers don't
 * understand. These are bookkeeping metadata used by the normalization
 * and thread layers.
 */
function stripInternalFields(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const result = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const asst = msg as AssistantMessage;
    if (asst._turnId === undefined) return msg;
    changed = true;
    const { _turnId, ...rest } = asst;
    return rest as AssistantMessage;
  });
  return changed ? result : messages;
}
