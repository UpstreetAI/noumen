import type { ChatMessage, StreamEvent } from "../session/types.js";
import type { VirtualFs } from "../virtual/fs.js";
import type { MicrocompactConfig } from "../compact/microcompact.js";
import type { ToolResultBudgetConfig, BudgetState } from "../compact/tool-result-budget.js";
import type { ToolResultStorageConfig, ContentReplacementState } from "../compact/tool-result-storage.js";
import { microcompactMessages } from "../compact/microcompact.js";
import { enforceToolResultBudget } from "../compact/tool-result-budget.js";
import { enforceToolResultStorageBudget } from "../compact/tool-result-storage.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";
import { assertValidMessageSequence } from "../messages/invariants.js";

export interface PrepareMessagesConfig {
  toolResultStorage?: ToolResultStorageConfig;
  microcompact?: MicrocompactConfig;
  toolResultBudget?: ToolResultBudgetConfig;
  fs?: VirtualFs;
  sessionId: string;
  debug?: boolean;
}

export interface PrepareMessagesState {
  contentReplacementState: ContentReplacementState;
  budgetState: BudgetState;
  microcompactTokensFreed: number;
}

export interface PrepareMessagesResult {
  messagesForApi: ChatMessage[];
  canonicalMessages: ChatMessage[];
  state: PrepareMessagesState;
  events: StreamEvent[];
}

/**
 * Runs the pre-call message preparation pipeline:
 * 1. Disk spill (replace oversized tool results with on-disk stubs)
 * 2. Microcompact (clear old compactable tool results with placeholders)
 * 3. Budget (truncate recent tool results on a snapshot copy)
 * 4. Normalize (dedup IDs, fix orphans, merge roles, ensure valid structure)
 *
 * Returns updated canonical messages (after steps 1-2) and an API-ready
 * snapshot (after steps 3-4), plus accumulated events and updated state.
 */
export async function prepareMessagesForApi(
  messages: ChatMessage[],
  config: PrepareMessagesConfig,
  state: PrepareMessagesState,
): Promise<PrepareMessagesResult> {
  const events: StreamEvent[] = [];
  let canonical = messages;
  let contentReplacementState = state.contentReplacementState;
  let budgetState = state.budgetState;
  let microcompactTokensFreed = state.microcompactTokensFreed;

  // Stage 1: Disk spill — idempotent replacement of oversized tool results
  if (config.toolResultStorage?.enabled && config.fs) {
    const storageResult = await enforceToolResultStorageBudget(
      canonical,
      config.toolResultStorage,
      config.fs,
      config.sessionId,
      contentReplacementState,
    );
    if (storageResult.tokensFreed > 0) {
      canonical = storageResult.messages;
      contentReplacementState = storageResult.state;
      microcompactTokensFreed += storageResult.tokensFreed;
    }
  }

  // Stage 2: Microcompact — clear old compactable tool results
  if (config.microcompact?.enabled) {
    const mcResult = microcompactMessages(canonical, config.microcompact);
    if (mcResult.tokensFreed > 0) {
      canonical = mcResult.messages;
      microcompactTokensFreed += mcResult.tokensFreed;
      events.push({ type: "microcompact_complete", tokensFreed: mcResult.tokensFreed });
    }
  }

  // Stage 3: Budget — truncate on a snapshot so canonical is not mutated
  let messagesForApi: ChatMessage[] = canonical;
  if (config.toolResultBudget?.enabled) {
    const budgetResult = enforceToolResultBudget(
      [...canonical],
      config.toolResultBudget,
      budgetState,
    );
    messagesForApi = budgetResult.messages;
    budgetState = budgetResult.state;
    microcompactTokensFreed += budgetResult.tokensFreed;
    for (const entry of budgetResult.truncatedEntries) {
      events.push({
        type: "tool_result_truncated",
        toolCallId: entry.toolCallId,
        originalChars: entry.originalChars,
        truncatedChars: entry.truncatedChars,
      });
    }
  }

  // Stage 4: Normalize for API validity
  messagesForApi = normalizeMessagesForAPI(messagesForApi);

  if (config.debug) {
    assertValidMessageSequence(messagesForApi);
  }

  return {
    messagesForApi,
    canonicalMessages: canonical,
    state: {
      contentReplacementState,
      budgetState,
      microcompactTokensFreed,
    },
    events,
  };
}
