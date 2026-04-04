import type { ChatMessage, AssistantMessage, ToolResultMessage } from "../session/types.js";
import { estimateTokens } from "../utils/tokens.js";
import { contentToString } from "../utils/content.js";

export interface ToolResultBudgetConfig {
  enabled: boolean;
  /** Max total chars across all tool results in one group. Default: 200_000 */
  maxCharsPerGroup?: number;
  /** Max chars for a single tool result before individual truncation. Default: 50_000 */
  maxCharsPerResult?: number;
  /** Number of preview chars to keep when truncating. Default: 1_000 */
  previewChars?: number;
}

/**
 * Tracks which tool_call_ids have already been truncated so that
 * decisions are deterministic across repeated calls and session resume.
 */
export interface BudgetState {
  truncatedIds: Set<string>;
}

export function createBudgetState(): BudgetState {
  return { truncatedIds: new Set() };
}

const DEFAULT_MAX_CHARS_PER_GROUP = 200_000;
const DEFAULT_MAX_CHARS_PER_RESULT = 50_000;
const DEFAULT_PREVIEW_CHARS = 1_000;

function buildPreview(content: string, previewChars: number): string {
  return (
    content.slice(0, previewChars) +
    `\n... [truncated, ${content.length} total chars]`
  );
}

/**
 * Group messages into API-round groups. A new group starts at every
 * assistant message that has a different identity from the previous one
 * (detected by the presence of tool_calls). Each group contains one
 * assistant message and all subsequent tool result messages.
 */
function groupByAssistantRound(
  messages: ChatMessage[],
): Array<{ startIdx: number; toolResultIndices: number[] }> {
  const groups: Array<{ startIdx: number; toolResultIndices: number[] }> = [];
  let current: { startIdx: number; toolResultIndices: number[] } | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      (msg as AssistantMessage).tool_calls &&
      (msg as AssistantMessage).tool_calls!.length > 0
    ) {
      if (current) groups.push(current);
      current = { startIdx: i, toolResultIndices: [] };
    } else if (msg.role === "tool" && current) {
      current.toolResultIndices.push(i);
    }
  }
  if (current) groups.push(current);
  return groups;
}

export interface ToolResultBudgetResult {
  messages: ChatMessage[];
  state: BudgetState;
  tokensFreed: number;
  truncatedEntries: Array<{
    toolCallId: string;
    originalChars: number;
    truncatedChars: number;
  }>;
}

/**
 * Enforce per-group and per-result character budgets on tool results.
 *
 * For each assistant-round group: first enforce per-result caps (truncate
 * any single result exceeding `maxCharsPerResult`), then if the group
 * total still exceeds `maxCharsPerGroup`, truncate the largest results
 * first until under budget.
 *
 * Tool results that were already truncated (tracked in `state`) are
 * left as-is for deterministic resume.
 */
export function enforceToolResultBudget(
  messages: ChatMessage[],
  config: ToolResultBudgetConfig,
  state?: BudgetState,
): ToolResultBudgetResult {
  if (!config.enabled) {
    return {
      messages,
      state: state ?? createBudgetState(),
      tokensFreed: 0,
      truncatedEntries: [],
    };
  }

  const maxPerGroup = config.maxCharsPerGroup ?? DEFAULT_MAX_CHARS_PER_GROUP;
  const maxPerResult = config.maxCharsPerResult ?? DEFAULT_MAX_CHARS_PER_RESULT;
  const previewChars = config.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const budgetState = state ?? createBudgetState();
  const result = [...messages];
  let totalTokensFreed = 0;
  const allTruncated: ToolResultBudgetResult["truncatedEntries"] = [];

  const groups = groupByAssistantRound(messages);

  for (const group of groups) {
    // Phase 1: per-result cap
    for (const idx of group.toolResultIndices) {
      const msg = result[idx] as ToolResultMessage;
      if (budgetState.truncatedIds.has(msg.tool_call_id)) continue;
      const text = contentToString(msg.content);
      if (text.length <= maxPerResult) continue;

      const originalChars = text.length;
      const preview = buildPreview(text, previewChars);
      result[idx] = { ...msg, content: preview };
      budgetState.truncatedIds.add(msg.tool_call_id);
      const freed = estimateTokens(text) - estimateTokens(preview);
      totalTokensFreed += Math.max(0, freed);
      allTruncated.push({
        toolCallId: msg.tool_call_id,
        originalChars,
        truncatedChars: preview.length,
      });
    }

    // Phase 2: group budget — sort by size descending, truncate largest first
    let groupTotal = 0;
    for (const idx of group.toolResultIndices) {
      groupTotal += contentToString((result[idx] as ToolResultMessage).content).length;
    }
    if (groupTotal <= maxPerGroup) continue;

    const sortedBySize = [...group.toolResultIndices].sort((a, b) => {
      return (
        contentToString((result[b] as ToolResultMessage).content).length -
        contentToString((result[a] as ToolResultMessage).content).length
      );
    });

    for (const idx of sortedBySize) {
      if (groupTotal <= maxPerGroup) break;
      const msg = result[idx] as ToolResultMessage;
      if (budgetState.truncatedIds.has(msg.tool_call_id)) continue;
      const text = contentToString(msg.content);
      if (text.length <= previewChars + 50) continue;

      const originalChars = text.length;
      const preview = buildPreview(text, previewChars);
      const freed = estimateTokens(text) - estimateTokens(preview);
      groupTotal -= originalChars - preview.length;
      totalTokensFreed += Math.max(0, freed);

      result[idx] = { ...msg, content: preview };
      budgetState.truncatedIds.add(msg.tool_call_id);
      allTruncated.push({
        toolCallId: msg.tool_call_id,
        originalChars,
        truncatedChars: preview.length,
      });
    }
  }

  return {
    messages: result as ChatMessage[],
    state: budgetState,
    tokensFreed: totalTokensFreed,
    truncatedEntries: allTruncated,
  };
}
