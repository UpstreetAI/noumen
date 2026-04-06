import type { AIProvider, ChatCompletionUsage } from "../providers/types.js";
import type { ChatMessage, StreamEvent } from "../session/types.js";
import type { HookDefinition } from "../hooks/types.js";
import type {
  AutoCompactConfig,
  AutoCompactTrackingState,
} from "../compact/auto-compact.js";
import {
  shouldAutoCompact,
  canAutoCompact,
  recordAutoCompactSuccess,
  recordAutoCompactFailure,
} from "../compact/auto-compact.js";
import { compactConversation } from "../compact/compact.js";
import { runNotificationHooks } from "../hooks/runner.js";
import { SessionStorage } from "../session/storage.js";

export interface AutoCompactStepResult {
  compacted: boolean;
  messages?: ChatMessage[];
  events: StreamEvent[];
}

/**
 * Checks whether the conversation exceeds the auto-compact threshold and,
 * if so, runs compaction. Returns the result so the caller can decide
 * whether to `continue` the loop or proceed to the provider call.
 *
 * Hook notifications (PreCompact, PostCompact, Error) are fired internally.
 * The tracking state is mutated in place (success/failure counters).
 */
export async function tryAutoCompactStep(
  messages: ChatMessage[],
  config: AutoCompactConfig,
  provider: AIProvider,
  model: string,
  state: {
    lastUsage: ChatCompletionUsage | undefined;
    anchorMessageIndex: number | undefined;
    microcompactTokensFreed: number;
    querySource: string | undefined;
    autoCompactTracking: AutoCompactTrackingState;
    recentlyReadFiles?: Map<string, string>;
    signal?: AbortSignal;
  },
  hooks: HookDefinition[],
  sessionId: string,
  storage: SessionStorage,
): Promise<AutoCompactStepResult> {
  if (
    !canAutoCompact(state.autoCompactTracking) ||
    !shouldAutoCompact(
      messages,
      config,
      state.lastUsage,
      state.anchorMessageIndex,
      state.microcompactTokensFreed,
      state.querySource,
    )
  ) {
    return { compacted: false, events: [] };
  }

  const events: StreamEvent[] = [];

  await runNotificationHooks(hooks, "PreCompact", {
    event: "PreCompact",
    sessionId,
  });
  events.push({ type: "compact_start" });

  try {
    const compactedMessages = await compactConversation(
      provider,
      model,
      messages,
      storage,
      sessionId,
      {
        tailMessagesToKeep: config.tailMessagesToKeep,
        stripBinaryContent: true,
        signal: state.signal,
        recentlyReadFiles:
          state.recentlyReadFiles && state.recentlyReadFiles.size > 0
            ? state.recentlyReadFiles
            : undefined,
      },
    );

    recordAutoCompactSuccess(state.autoCompactTracking);
    events.push({ type: "compact_complete" });

    await runNotificationHooks(hooks, "PostCompact", {
      event: "PostCompact",
      sessionId,
    });

    return { compacted: true, messages: compactedMessages, events };
  } catch (compactErr) {
    recordAutoCompactFailure(state.autoCompactTracking);

    const error =
      compactErr instanceof Error
        ? compactErr
        : new Error(`Compaction failed: ${String(compactErr)}`);

    await runNotificationHooks(hooks, "Error", {
      event: "Error",
      sessionId,
      error,
    });

    events.push({ type: "auto_compact_failed", error });
    return { compacted: false, events };
  }
}
