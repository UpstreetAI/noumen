/**
 * Conversation recovery and message sanitization.
 *
 * Cleans up persisted messages before resuming a session so the API
 * receives a structurally valid conversation. Handles crashes, streaming
 * interruptions, orphaned tool calls, and whitespace-only messages.
 */

import type {
  ChatMessage,
  AssistantMessage,
  ToolResultMessage,
  ContentPart,
} from "./types.js";
import { contentToString } from "../utils/content.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TurnInterruption =
  | { kind: "none" }
  | { kind: "interrupted_tool" }
  | { kind: "interrupted_prompt" };

export interface SanitizeResult {
  messages: ChatMessage[];
  interruption: TurnInterruption;
  /** Number of messages removed by each filter (for diagnostics). */
  removals: {
    unresolvedToolUses: number;
    whitespaceOnly: number;
    orphanedThinking: number;
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Drop assistant messages where *every* tool_call has no matching tool
 * result message. Keeps assistants that have at least one resolved call
 * or no tool_calls at all.
 */
export function filterUnresolvedToolUses(messages: ChatMessage[]): {
  messages: ChatMessage[];
  removed: number;
} {
  const resolvedToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool") {
      resolvedToolCallIds.add((msg as ToolResultMessage).tool_call_id);
    }
  }

  // Collect tool_call IDs from assistant messages that will be removed
  const removedToolCallIds = new Set<string>();
  let removed = 0;

  const filtered = messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const asst = msg as AssistantMessage;
    if (!asst.tool_calls || asst.tool_calls.length === 0) return true;

    const allUnresolved = asst.tool_calls.every(
      (tc) => !resolvedToolCallIds.has(tc.id),
    );
    if (allUnresolved) {
      for (const tc of asst.tool_calls) {
        removedToolCallIds.add(tc.id);
      }
      removed++;
      return false;
    }
    return true;
  });

  // Also remove orphaned tool result messages whose assistant was dropped
  const cleaned = filtered.filter((msg) => {
    if (msg.role !== "tool") return true;
    const toolMsg = msg as ToolResultMessage;
    if (removedToolCallIds.has(toolMsg.tool_call_id)) {
      return false;
    }
    return true;
  });

  return { messages: cleaned, removed };
}

/**
 * Drop assistant messages that are whitespace-only text with no
 * tool_calls (API-invalid). After removal, merge consecutive user
 * messages to restore role alternation.
 */
export function filterWhitespaceOnlyAssistantMessages(messages: ChatMessage[]): {
  messages: ChatMessage[];
  removed: number;
} {
  let removed = 0;
  const filtered = messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const asst = msg as AssistantMessage;
    if (asst.tool_calls && asst.tool_calls.length > 0) return true;

    const text = typeof asst.content === "string" ? asst.content : contentToString(asst.content ?? "");
    if (text.trim() === "") {
      removed++;
      return false;
    }
    return true;
  });

  if (removed === 0) return { messages: filtered, removed };

  return { messages: mergeConsecutiveSameRole(filtered), removed };
}

/**
 * Drop assistant messages that contain only thinking content (no
 * real text and no tool_calls). These are artifacts of streaming
 * interruptions where a thinking block was streamed but the model
 * never produced a real response.
 *
 * In noumen's format, thinking content appears as `content: null`
 * with no tool_calls (the thinking deltas were streamed separately).
 * We detect these as assistants with null/empty content and no calls.
 */
export function filterOrphanedThinkingMessages(messages: ChatMessage[]): {
  messages: ChatMessage[];
  removed: number;
} {
  let removed = 0;
  const filtered = messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const asst = msg as AssistantMessage;
    if (asst.tool_calls && asst.tool_calls.length > 0) return true;
    if (asst.content === null || asst.content === undefined) {
      removed++;
      return false;
    }
    return true;
  });

  return { messages: filtered, removed };
}

// ---------------------------------------------------------------------------
// Turn interruption detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the conversation was interrupted mid-turn.
 *
 * Walks backward from the end skipping system messages to find the
 * last significant message. Returns `interrupted_tool` when the last
 * message is a tool result (agent got results but model never replied),
 * `interrupted_prompt` when the last message is a user prompt (model
 * never started), or `none` otherwise.
 */
export function detectTurnInterruption(messages: ChatMessage[]): TurnInterruption {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      return { kind: "interrupted_tool" };
    }
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : contentToString(msg.content as string | import("./types.js").ContentPart[]);
      if (text.startsWith("[Conversation Summary]")) {
        return { kind: "none" };
      }
      return { kind: "interrupted_prompt" };
    }
    return { kind: "none" };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full sanitization pipeline on a set of persisted messages.
 *
 * Order matters:
 * 1. Remove unresolved tool uses (structural — fixes orphan tool_calls)
 * 2. Remove orphaned thinking messages (streaming artifacts)
 * 3. Remove whitespace-only assistants (API validity)
 * 4. Detect turn interruption (must happen last, on clean messages)
 */
export function sanitizeForResume(messages: ChatMessage[]): SanitizeResult {
  const step1 = filterUnresolvedToolUses(messages);
  const step1b = fillPartiallyResolvedToolCalls(step1.messages);
  const step2 = filterOrphanedThinkingMessages(step1b.messages);
  const step3 = filterWhitespaceOnlyAssistantMessages(step2.messages);

  const interruption = detectTurnInterruption(step3.messages);

  return {
    messages: step3.messages,
    interruption,
    removals: {
      unresolvedToolUses: step1.removed,
      whitespaceOnly: step3.removed,
      orphanedThinking: step2.removed,
    },
  };
}

/**
 * For assistant messages that have SOME resolved tool_calls but not all,
 * generate synthetic error results for the missing ones so the API
 * receives a complete conversation.
 *
 * Synthetic results are inserted after the last real tool result for the
 * assistant's calls (not immediately after the assistant message) so
 * conversation ordering is preserved.
 */
function fillPartiallyResolvedToolCalls(messages: ChatMessage[]): {
  messages: ChatMessage[];
} {
  const resolvedIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool") {
      resolvedIds.add((msg as ToolResultMessage).tool_call_id);
    }
  }

  // Collect which assistants have unresolved calls and what those IDs are
  const unresolvedByAssistantIdx = new Map<number, string[]>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const asst = msg as AssistantMessage;
    if (!asst.tool_calls || asst.tool_calls.length === 0) continue;

    const missing = asst.tool_calls
      .filter((tc) => !resolvedIds.has(tc.id))
      .map((tc) => tc.id);
    if (missing.length > 0) {
      unresolvedByAssistantIdx.set(i, missing);
    }
  }

  if (unresolvedByAssistantIdx.size === 0) return { messages };

  // For each assistant with unresolved calls, find the insertion point:
  // after the last real tool result for any of the assistant's calls,
  // or immediately after the assistant if none exist.
  const insertions = new Map<number, ToolResultMessage[]>();
  for (const [asstIdx, missingIds] of unresolvedByAssistantIdx) {
    const asst = messages[asstIdx] as AssistantMessage;
    const allCallIds = new Set(asst.tool_calls!.map((tc) => tc.id));

    let lastResultIdx = asstIdx;
    for (let j = asstIdx + 1; j < messages.length; j++) {
      if (messages[j].role === "tool" && allCallIds.has((messages[j] as ToolResultMessage).tool_call_id)) {
        lastResultIdx = j;
      }
    }

    const synthetics: ToolResultMessage[] = missingIds.map((id) => ({
      role: "tool" as const,
      tool_call_id: id,
      content: "Error: Tool result missing due to interrupted session.",
      isError: true,
    }));
    const existing = insertions.get(lastResultIdx);
    if (existing) {
      existing.push(...synthetics);
    } else {
      insertions.set(lastResultIdx, synthetics);
    }
  }

  const result: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    result.push(messages[i]);
    const toInsert = insertions.get(i);
    if (toInsert) {
      result.push(...toInsert);
    }
  }

  return { messages: result };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Merge consecutive messages with the same role to restore valid
 * role alternation after removing messages from the middle.
 */
function mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 1) return messages;

  const result: ChatMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (prev.role === "user" && curr.role === "user") {
      const prevParts: ContentPart[] = typeof prev.content === "string"
        ? [{ type: "text", text: prev.content }]
        : Array.isArray(prev.content)
          ? (prev.content as ContentPart[])
          : [{ type: "text", text: contentToString(prev.content) }];
      const currParts: ContentPart[] = typeof curr.content === "string"
        ? [{ type: "text", text: curr.content }]
        : Array.isArray(curr.content)
          ? (curr.content as ContentPart[])
          : [{ type: "text", text: contentToString(curr.content) }];
      result[result.length - 1] = {
        role: "user",
        content: [...prevParts, ...currParts],
      };
    } else if (prev.role === "assistant" && curr.role === "assistant") {
      const prevAsst = prev as AssistantMessage;
      const currAsst = curr as AssistantMessage;
      const prevText = typeof prevAsst.content === "string"
        ? prevAsst.content
        : Array.isArray(prevAsst.content)
          ? contentToString(prevAsst.content as ContentPart[])
          : "";
      const currText = typeof currAsst.content === "string"
        ? currAsst.content
        : Array.isArray(currAsst.content)
          ? contentToString(currAsst.content as ContentPart[])
          : "";
      const mergedContent = (prevText || currText)
        ? (prevText + (currText ? "\n" + currText : ""))
        : null;
      const mergedToolCalls = [
        ...(prevAsst.tool_calls ?? []),
        ...(currAsst.tool_calls ?? []),
      ];
      result[result.length - 1] = {
        role: "assistant",
        content: mergedContent,
        ...(mergedToolCalls.length > 0 ? { tool_calls: mergedToolCalls } : {}),
        ...(prevAsst.thinking_content ? { thinking_content: prevAsst.thinking_content } : {}),
        ...(prevAsst.thinking_signature ? { thinking_signature: prevAsst.thinking_signature } : {}),
        ...(prevAsst.redacted_thinking_data ? { redacted_thinking_data: prevAsst.redacted_thinking_data } : {}),
      } as AssistantMessage;
    } else {
      result.push(curr);
    }
  }

  return result;
}

/**
 * Generate synthetic tool result messages for tool_calls in an
 * assistant message that have no matching result yet. Used to
 * prevent orphaned tool_calls from corrupting the conversation
 * when streaming is interrupted or provider errors occur.
 */
export function generateMissingToolResults(
  assistantMsg: AssistantMessage,
  existingResults: ChatMessage[],
  reason: string,
): ToolResultMessage[] {
  if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) return [];

  const resolvedIds = new Set<string>();
  for (const msg of existingResults) {
    if (msg.role === "tool") {
      resolvedIds.add((msg as ToolResultMessage).tool_call_id);
    }
  }

  const missing: ToolResultMessage[] = [];
  for (const tc of assistantMsg.tool_calls) {
    if (!resolvedIds.has(tc.id)) {
      missing.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `Error: ${reason}`,
        isError: true,
      });
    }
  }

  return missing;
}
