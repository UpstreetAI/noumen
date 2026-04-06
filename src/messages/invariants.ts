/**
 * Runtime invariant assertions for normalized message sequences.
 *
 * `assertValidMessageSequence` throws an `InvariantViolation` error
 * when a ChatMessage[] violates the structural rules that every LLM
 * provider expects. Wire it behind a `debug` flag in thread.ts to
 * catch normalization regressions during development and testing.
 */

import type {
  ChatMessage,
  AssistantMessage,
  ToolResultMessage,
} from "../session/types.js";
import { contentToString } from "../utils/content.js";

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolation";
  }
}

/**
 * Assert that `messages` is a structurally valid sequence for the LLM API.
 *
 * Checks:
 *  1. Non-empty (at least one message)
 *  2. First message has role "user"
 *  3. No system messages
 *  4. No consecutive same-role (non-tool) messages
 *  5. Every tool_use has exactly one matching tool result
 *  6. No orphaned tool results (no matching tool_use)
 *  7. No duplicate tool_use IDs
 *  8. No duplicate tool_result IDs
 *  9. No assistant with null/undefined content
 * 10. No whitespace-only assistant without tool_calls or thinking_content
 * 11. Trailing assistant must not be thinking-only (no text, no tool_calls)
 * 12. Tool results appear in a contiguous block after their owning assistant
 */
export function assertValidMessageSequence(messages: ChatMessage[]): void {
  if (messages.length === 0) {
    throw new InvariantViolation("Message sequence is empty");
  }

  if (messages[0].role !== "user") {
    throw new InvariantViolation(
      `First message must be role "user", got "${messages[0].role}"`,
    );
  }

  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  // Map tool_use id → index of the assistant that owns it
  const toolUseOwnerIdx = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      throw new InvariantViolation(`message[${i}] is a system message`);
    }

    if (i > 0) {
      const prev = messages[i - 1];
      if (msg.role !== "tool" && prev.role !== "tool" && msg.role === prev.role) {
        throw new InvariantViolation(
          `Consecutive same-role: messages[${i - 1}] and [${i}] are both "${msg.role}"`,
        );
      }
    }

    if (msg.role === "assistant") {
      const asst = msg as AssistantMessage;

      if (asst.content === null || asst.content === undefined) {
        throw new InvariantViolation(
          `message[${i}] assistant has null/undefined content`,
        );
      }

      // Invariant #10: whitespace-only assistant without tool_calls or thinking
      if (!asst.tool_calls || asst.tool_calls.length === 0) {
        const text =
          typeof asst.content === "string"
            ? asst.content
            : contentToString(asst.content ?? "");
        if (text.trim() === "" && !asst.thinking_content) {
          throw new InvariantViolation(
            `message[${i}] is a whitespace-only assistant with no tool_calls or thinking_content`,
          );
        }
      }

      if (asst.tool_calls) {
        for (const tc of asst.tool_calls) {
          if (toolUseIds.has(tc.id)) {
            throw new InvariantViolation(
              `Duplicate tool_use ID "${tc.id}" at message[${i}]`,
            );
          }
          toolUseIds.add(tc.id);
          toolUseOwnerIdx.set(tc.id, i);
        }
      }
    } else if (msg.role === "tool") {
      const tr = msg as ToolResultMessage;
      if (toolResultIds.has(tr.tool_call_id)) {
        throw new InvariantViolation(
          `Duplicate tool_result ID "${tr.tool_call_id}" at message[${i}]`,
        );
      }
      toolResultIds.add(tr.tool_call_id);
    }
  }

  // Every tool_use must have a matching tool_result
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      throw new InvariantViolation(
        `tool_use "${id}" has no matching tool_result`,
      );
    }
  }

  // Every tool_result must have a matching tool_use
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) {
      throw new InvariantViolation(
        `tool_result "${id}" has no matching tool_use`,
      );
    }
  }

  // Invariant #11: trailing assistant must not be thinking-only
  const last = messages[messages.length - 1];
  if (last.role === "assistant") {
    const asst = last as AssistantMessage;
    if ((!asst.tool_calls || asst.tool_calls.length === 0) && asst.thinking_content) {
      const text =
        typeof asst.content === "string"
          ? asst.content
          : contentToString(asst.content ?? "");
      if (text.trim() === "") {
        throw new InvariantViolation(
          "Trailing assistant is thinking-only (no text content, no tool_calls)",
        );
      }
    }
  }

  // Invariant #12: tool results must appear after their owning assistant,
  // with no intervening non-tool messages between the assistant and its results.
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "tool") continue;
    const tr = messages[i] as ToolResultMessage;
    const ownerIdx = toolUseOwnerIdx.get(tr.tool_call_id);
    if (ownerIdx === undefined) continue; // orphan already caught above

    if (i <= ownerIdx) {
      throw new InvariantViolation(
        `tool_result "${tr.tool_call_id}" at message[${i}] appears before its owning assistant at message[${ownerIdx}]`,
      );
    }

    // Check no non-tool, non-assistant-with-same-owner messages intervene
    // between the owning assistant and this tool result — i.e., a user message
    // must not separate an assistant from its tool results.
    for (let j = ownerIdx + 1; j < i; j++) {
      if (messages[j].role === "user") {
        throw new InvariantViolation(
          `tool_result "${tr.tool_call_id}" at message[${i}] is separated from its owning assistant[${ownerIdx}] by a user message at [${j}]`,
        );
      }
    }
  }
}
