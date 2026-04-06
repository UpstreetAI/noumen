/**
 * Disk-backed tool result storage.
 *
 * When a tool result exceeds a size threshold, the full content is persisted
 * to VirtualFs and replaced in-memory with a compact stub containing a
 * preview and path. This prevents context window bloat while preserving
 * the full data for resume.
 */

import type { VirtualFs } from "../virtual/fs.js";
import type { ChatMessage, ToolResultMessage, AssistantMessage } from "../session/types.js";
import { contentToString } from "../utils/content.js";
import { estimateTokens } from "../utils/tokens.js";

export interface ToolResultStorageConfig {
  enabled: boolean;
  /** Directory under which persisted results are stored. Default: ".noumen/tool-results" */
  storageDir?: string;
  /** Char threshold for a single result before spilling to disk. Default: 50_000 */
  defaultThreshold?: number;
  /** Per-tool overrides (tool name -> threshold). Use Infinity to never persist. */
  perToolThresholds?: Record<string, number>;
  /** Chars to keep as preview in the replacement stub. Default: 2_000 */
  previewChars?: number;
  /** Per-message aggregate budget for all tool results. Default: 200_000 */
  perMessageBudget?: number;
}

/**
 * Tracks which tool results have been replaced, enabling deterministic
 * resume — previously replaced results are re-applied from the stored
 * replacement string without re-reading from disk.
 */
export interface ContentReplacementState {
  seenIds: Set<string>;
  replacements: Map<string, string>;
}

export interface ContentReplacementRecord {
  toolUseId: string;
  replacement: string;
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() };
}

const DEFAULT_THRESHOLD = 50_000;
const DEFAULT_PREVIEW_CHARS = 2_000;
const DEFAULT_PER_MESSAGE_BUDGET = 200_000;
const DEFAULT_STORAGE_DIR = ".noumen/tool-results";

function contentSize(content: string | unknown[]): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (typeof block === "object" && block !== null && "text" in block) {
        total += (block as { text: string }).text.length;
      }
    }
    return total;
  }
  return 0;
}

function generatePreview(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  // Prefer breaking at a newline boundary
  const slice = content.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > maxChars * 0.5) {
    return slice.slice(0, lastNewline);
  }
  return slice;
}

function getThreshold(
  toolName: string,
  config: ToolResultStorageConfig,
): number {
  const perTool = config.perToolThresholds?.[toolName];
  if (perTool !== undefined) return perTool;
  return config.defaultThreshold ?? DEFAULT_THRESHOLD;
}

function buildReplacementStub(
  filePath: string,
  originalSize: number,
  preview: string,
): string {
  return (
    `<persisted-output path="${filePath}" size="${originalSize}">\n` +
    preview +
    "\n</persisted-output>"
  );
}

/**
 * Persist a single oversized tool result to disk and return a replacement stub.
 * Returns null if the content is below threshold.
 */
export async function persistToolResult(
  fs: VirtualFs,
  sessionId: string,
  toolUseId: string,
  toolName: string,
  content: string,
  config: ToolResultStorageConfig,
): Promise<string | null> {
  const threshold = getThreshold(toolName, config);
  if (!Number.isFinite(threshold)) return null;
  if (content.length <= threshold) return null;

  const storageDir = config.storageDir ?? DEFAULT_STORAGE_DIR;
  const dir = `${storageDir}/${sessionId}/tool-results`;
  const filePath = `${dir}/${toolUseId}.txt`;
  const previewChars = config.previewChars ?? DEFAULT_PREVIEW_CHARS;

  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(filePath, content);

  const preview = generatePreview(content, previewChars);
  return buildReplacementStub(filePath, content.length, preview);
}

export interface ToolResultSpillResult {
  messages: ChatMessage[];
  state: ContentReplacementState;
  tokensFreed: number;
  spilledEntries: ContentReplacementRecord[];
}

/**
 * Enforce per-message tool result budget by spilling the largest results to disk.
 *
 * For each assistant turn group, if the total tool result size exceeds
 * `perMessageBudget`, the largest results are spilled first.
 */
export async function enforceToolResultStorageBudget(
  messages: ChatMessage[],
  config: ToolResultStorageConfig,
  fs: VirtualFs,
  sessionId: string,
  state?: ContentReplacementState,
): Promise<ToolResultSpillResult> {
  if (!config.enabled) {
    return {
      messages,
      state: state ?? createContentReplacementState(),
      tokensFreed: 0,
      spilledEntries: [],
    };
  }

  const replacementState = state ?? createContentReplacementState();
  const budget = config.perMessageBudget ?? DEFAULT_PER_MESSAGE_BUDGET;
  const result = [...messages];

  const toolCallIdToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && (msg as AssistantMessage).tool_calls) {
      for (const tc of (msg as AssistantMessage).tool_calls!) {
        toolCallIdToName.set(tc.id, tc.function.name);
      }
    }
  }
  let totalTokensFreed = 0;
  const allSpilled: ContentReplacementRecord[] = [];

  // Group tool results by preceding assistant message
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== "tool") continue;
    const toolMsg = msg as ToolResultMessage;

    // Already replaced in a previous run
    if (replacementState.seenIds.has(toolMsg.tool_call_id)) {
      const existingReplacement = replacementState.replacements.get(toolMsg.tool_call_id);
      if (existingReplacement) {
        result[i] = { ...toolMsg, content: existingReplacement };
      }
      continue;
    }
    replacementState.seenIds.add(toolMsg.tool_call_id);
  }

  // Collect tool result indices grouped by assistant turns
  const groups: Array<{ toolIndices: number[] }> = [];
  let currentGroup: { toolIndices: number[] } | null = null;

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls?.length) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { toolIndices: [] };
    } else if (msg.role === "tool" && currentGroup) {
      currentGroup.toolIndices.push(i);
    }
  }
  if (currentGroup) groups.push(currentGroup);

  for (const group of groups) {
    // Calculate group total
    let groupTotal = 0;
    const sizes: Array<{ idx: number; size: number }> = [];
    for (const idx of group.toolIndices) {
      const toolMsg = result[idx] as ToolResultMessage;
      if (replacementState.replacements.has(toolMsg.tool_call_id)) continue;
      const size = contentSize(toolMsg.content);
      groupTotal += size;
      sizes.push({ idx, size });
    }

    if (groupTotal <= budget) continue;

    // Sort largest first and spill until under budget
    sizes.sort((a, b) => b.size - a.size);

    for (const { idx, size } of sizes) {
      if (groupTotal <= budget) break;
      const toolMsg = result[idx] as ToolResultMessage;
      const text = contentToString(toolMsg.content);
      if (text.length < (config.previewChars ?? DEFAULT_PREVIEW_CHARS) + 100) continue;

      const toolName = toolCallIdToName.get(toolMsg.tool_call_id) ?? "unknown";
      const replacement = await persistToolResult(
        fs,
        sessionId,
        toolMsg.tool_call_id,
        toolName,
        text,
        config,
      );

      if (replacement) {
        const freed = estimateTokens(text) - estimateTokens(replacement);
        totalTokensFreed += Math.max(0, freed);
        groupTotal -= size - replacement.length;

        result[idx] = { ...toolMsg, content: replacement };
        replacementState.replacements.set(toolMsg.tool_call_id, replacement);
        allSpilled.push({
          toolUseId: toolMsg.tool_call_id,
          replacement,
        });
      }
    }
  }

  return {
    messages: result as ChatMessage[],
    state: replacementState,
    tokensFreed: totalTokensFreed,
    spilledEntries: allSpilled,
  };
}

/**
 * Reconstruct ContentReplacementState from persisted records (used during session resume).
 */
export function reconstructContentReplacementState(
  records: ContentReplacementRecord[],
  messages?: ChatMessage[],
): ContentReplacementState {
  const state = createContentReplacementState();

  for (const record of records) {
    state.seenIds.add(record.toolUseId);
    state.replacements.set(record.toolUseId, record.replacement);
  }

  // Also mark all tool result IDs in current messages as seen
  if (messages) {
    for (const msg of messages) {
      if (msg.role === "tool") {
        state.seenIds.add((msg as ToolResultMessage).tool_call_id);
      }
    }
  }

  return state;
}

/**
 * Re-apply persisted replacements to loaded messages (for resume).
 */
export function applyPersistedReplacements(
  messages: ChatMessage[],
  state: ContentReplacementState,
): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const toolMsg = msg as ToolResultMessage;
    const replacement = state.replacements.get(toolMsg.tool_call_id);
    if (replacement) {
      return { ...toolMsg, content: replacement };
    }
    return msg;
  });
}
