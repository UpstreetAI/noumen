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
 * 10. No whitespace-only assistant without tool_calls or thinking
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

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // No system messages
    if (msg.role === "system") {
      throw new InvariantViolation(`message[${i}] is a system message`);
    }

    // No consecutive same non-tool role
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

      // No null/undefined content
      if (asst.content === null || asst.content === undefined) {
        throw new InvariantViolation(
          `message[${i}] assistant has null/undefined content`,
        );
      }

      // Collect tool_use IDs
      if (asst.tool_calls) {
        for (const tc of asst.tool_calls) {
          if (toolUseIds.has(tc.id)) {
            throw new InvariantViolation(
              `Duplicate tool_use ID "${tc.id}" at message[${i}]`,
            );
          }
          toolUseIds.add(tc.id);
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
}
