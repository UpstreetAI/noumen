import type { ChatMessage, ContentPart, StreamEvent } from "../session/types.js";
import type { HookDefinition } from "../hooks/types.js";
import type { FileCheckpointManager } from "../checkpoint/manager.js";
import type { CostTracker } from "../cost/tracker.js";
import type {
  ToolResultStorageConfig,
  ContentReplacementState,
} from "../compact/tool-result-storage.js";
import {
  reconstructContentReplacementState,
  applyPersistedReplacements,
  enforceToolResultStorageBudget,
} from "../compact/tool-result-storage.js";
import type { VirtualFs } from "../virtual/fs.js";
import { restoreSession } from "../session/resume.js";
import { runNotificationHooks } from "../hooks/runner.js";
import { SessionStorage } from "../session/storage.js";
import { generateUUID } from "../utils/uuid.js";

export interface InitializeSessionParams {
  storage: SessionStorage;
  sessionId: string;
  hooks: HookDefinition[];
  prompt: string | ContentPart[];
  resumeRequested: boolean;
  loaded: boolean;
  messages: ChatMessage[];
  contentReplacementState: ContentReplacementState;
  isResumeRun: boolean;
  checkpointManager?: FileCheckpointManager;
  costTracker?: CostTracker;
  toolResultStorage?: ToolResultStorageConfig;
  fs: VirtualFs;
}

export interface InitializeSessionResult {
  messages: ChatMessage[];
  contentReplacementState: ContentReplacementState;
  events: StreamEvent[];
  loaded: boolean;
  resumeRequested: boolean;
  turnMessageId: string;
}

export async function initializeSession(
  params: InitializeSessionParams,
): Promise<InitializeSessionResult> {
  const {
    storage,
    sessionId,
    hooks,
    prompt,
    isResumeRun,
    checkpointManager,
    costTracker,
    toolResultStorage,
    fs,
  } = params;

  let { messages, contentReplacementState, loaded, resumeRequested } = params;
  const events: StreamEvent[] = [];

  if (!loaded) {
    if (resumeRequested) {
      const payload = await restoreSession(storage, sessionId);
      messages = payload.messages;

      if (checkpointManager && payload.checkpointSnapshots.length > 0) {
        checkpointManager.restoreStateFromEntries(payload.checkpointSnapshots);
      }

      if (costTracker && payload.costState) {
        costTracker.restore(payload.costState);
      }

      if (payload.contentReplacements.length > 0) {
        contentReplacementState = reconstructContentReplacementState(
          payload.contentReplacements,
          messages,
        );
        messages = applyPersistedReplacements(
          messages,
          contentReplacementState,
        );
      }

      if (toolResultStorage?.enabled && fs) {
        const storageResult = await enforceToolResultStorageBudget(
          messages,
          toolResultStorage,
          fs,
          sessionId,
          contentReplacementState,
        );
        messages = storageResult.messages;
        contentReplacementState = storageResult.state;
      }

      for (const [filterName, count] of Object.entries(payload.recoveryRemovals)) {
        if (count > 0) {
          events.push({ type: "recovery_filtered", filterName, removedCount: count });
        }
      }

      if (payload.interruption.kind !== "none") {
        events.push({
          type: "interrupted_turn_detected",
          kind: payload.interruption.kind,
        });
      }

      resumeRequested = false;
      events.push({ type: "session_resumed", sessionId, messageCount: messages.length });
    } else {
      messages = await storage.loadMessages(sessionId);
    }
    loaded = true;
  }

  const userMessage: ChatMessage = { role: "user", content: prompt };
  messages.push(userMessage);
  await storage.appendMessage(sessionId, userMessage);

  const turnMessageId = generateUUID();

  if (checkpointManager) {
    await checkpointManager.makeSnapshot(turnMessageId, sessionId);
    await storage.appendCheckpointEntry(
      sessionId,
      turnMessageId,
      checkpointManager.getState().snapshots.at(-1)!,
      false,
    );
    events.push({ type: "checkpoint_snapshot", messageId: turnMessageId });
  }

  await runNotificationHooks(hooks, "SessionStart", {
    event: "SessionStart",
    sessionId,
    prompt,
    isResume: isResumeRun,
  } as import("../hooks/types.js").SessionStartHookInput);

  return {
    messages,
    contentReplacementState,
    events,
    loaded,
    resumeRequested,
    turnMessageId,
  };
}
