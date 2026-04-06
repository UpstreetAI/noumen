/**
 * Normalize tool-call arguments before sending to providers.
 *
 * Strips fields that were injected for internal bookkeeping (e.g.
 * plan-mode metadata, legacy synthetic fields) but are not part of
 * the tool's declared API schema. Prevents 400 errors from providers
 * that strictly validate tool_use inputs.
 */

import type {
  ChatMessage,
  AssistantMessage,
  ToolCallContent,
} from "../session/types.js";

/**
 * Fields that are known to be injected by the runtime and must not
 * reach the provider. Keyed by tool name; `"*"` applies to all tools.
 */
const STRIP_FIELDS: Record<string, string[]> = {
  "*": ["_meta", "_source", "_injected"],
  ExitPlanMode: ["planFilePath"],
  EditFile: ["old_string", "new_string", "replace_all"],
};

/**
 * Strip synthetic/injected fields from a single tool call's arguments.
 * Returns the original string if no changes are needed.
 */
export function normalizeToolInputForAPI(
  toolName: string,
  argsJson: string,
): string {
  const globalFields = STRIP_FIELDS["*"] ?? [];
  const toolFields = STRIP_FIELDS[toolName] ?? [];
  const allFields = [...globalFields, ...toolFields];
  if (allFields.length === 0) return argsJson;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return argsJson;
  }

  if (typeof parsed !== "object" || parsed === null) return argsJson;

  let changed = false;
  for (const field of allFields) {
    if (field in parsed) {
      delete parsed[field];
      changed = true;
    }
  }

  // For EditFile: only strip old_string/new_string/replace_all when the
  // `edits` array is present (legacy resume format). Don't strip them
  // when they are the primary inputs (current format).
  if (toolName === "EditFile" && !("edits" in parsed)) {
    // Restore fields that were removed but are actually current-format inputs
    try {
      const original = JSON.parse(argsJson);
      for (const f of ["old_string", "new_string", "replace_all"]) {
        if (f in original && !(f in parsed)) {
          parsed[f] = original[f];
          changed = false; // Undo the strip for this field
        }
      }
    } catch {
      // noop
    }
  }

  return changed ? JSON.stringify(parsed) : argsJson;
}

/**
 * Walk all assistant messages and normalize their tool_call arguments.
 * Returns the original array if no changes are needed.
 */
export function normalizeToolInputsInMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  let changed = false;
  const result = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const asst = msg as AssistantMessage;
    if (!asst.tool_calls || asst.tool_calls.length === 0) return msg;

    let callsChanged = false;
    const newCalls = asst.tool_calls.map((tc: ToolCallContent) => {
      const normalized = normalizeToolInputForAPI(
        tc.function.name,
        tc.function.arguments,
      );
      if (normalized !== tc.function.arguments) {
        callsChanged = true;
        return { ...tc, function: { ...tc.function, arguments: normalized } };
      }
      return tc;
    });

    if (callsChanged) {
      changed = true;
      return { ...asst, tool_calls: newCalls };
    }
    return msg;
  });
  return changed ? result : messages;
}
