import type { ChatMessage, AssistantMessage } from "../session/types.js";
import { estimateTokens } from "../utils/tokens.js";
import { contentToString } from "../utils/content.js";

export interface MicrocompactConfig {
  enabled: boolean;
  /** Keep the N most recent compactable tool results uncleared. Default: 5 */
  keepRecent?: number;
}

export interface MicrocompactResult {
  messages: ChatMessage[];
  tokensFreed: number;
}

/**
 * Tools whose results can be safely cleared to free context tokens.
 * Includes read-heavy tools (ReadFile, Grep, Glob, WebFetch, WebSearch,
 * Bash) as well as mutation tools (EditFile, WriteFile) whose results
 * are short confirmation strings the model can reconstruct from context.
 */
export const COMPACTABLE_TOOLS = new Set([
  "ReadFile",
  "EditFile",
  "WriteFile",
  "Bash",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
]);

export const CLEARED_PLACEHOLDER = "[tool result cleared to save context]";

/**
 * Resolve the tool name that produced a given tool result message by
 * finding the preceding assistant message's matching tool_call entry.
 */
function resolveToolName(
  messages: ChatMessage[],
  toolResultIndex: number,
): string | undefined {
  const msg = messages[toolResultIndex];
  if (msg.role !== "tool") return undefined;
  const toolCallId = msg.tool_call_id;

  for (let i = toolResultIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && (m as AssistantMessage).tool_calls) {
      const tc = (m as AssistantMessage).tool_calls!.find(
        (c) => c.id === toolCallId,
      );
      if (tc) return tc.function.name;
    }
  }
  return undefined;
}

/**
 * Clear the content of old tool-result messages to free context tokens
 * without a full summarization pass.
 *
 * Only results from {@link COMPACTABLE_TOOLS} are eligible. The most
 * recent `keepRecent` eligible results are preserved; older ones have
 * their content replaced with {@link CLEARED_PLACEHOLDER}.
 *
 * Returns a **new** messages array (shallow-copied where unchanged).
 */
export function microcompactMessages(
  messages: ChatMessage[],
  config: MicrocompactConfig,
): MicrocompactResult {
  if (!config.enabled) return { messages, tokensFreed: 0 };

  const keepRecent = config.keepRecent ?? 5;

  // Collect indices of compactable tool results in order
  const compactableIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;
    if (msg.content === CLEARED_PLACEHOLDER) continue;

    const toolName = resolveToolName(messages, i);
    if (toolName && COMPACTABLE_TOOLS.has(toolName)) {
      compactableIndices.push(i);
    }
  }

  // Nothing to clear if we have fewer eligible results than keepRecent
  const clearCount = compactableIndices.length - keepRecent;
  if (clearCount <= 0) return { messages, tokensFreed: 0 };

  const indicesToClear = new Set(compactableIndices.slice(0, clearCount));

  let tokensFreed = 0;
  const result = messages.map((msg, idx) => {
    if (!indicesToClear.has(idx)) return msg;
    const originalText = contentToString(msg.content as string | import("../session/types.js").ContentPart[]);
    tokensFreed += estimateTokens(originalText) - estimateTokens(CLEARED_PLACEHOLDER);
    return { ...msg, content: CLEARED_PLACEHOLDER };
  });

  return { messages: result as ChatMessage[], tokensFreed: Math.max(0, tokensFreed) };
}
