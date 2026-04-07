import type {
  AIProvider,
  ChatCompletionUsage,
  OutputFormat,
} from "../providers/types.js";
import type {
  ChatMessage,
  AssistantMessage,
  StreamEvent,
} from "../session/types.js";
import type { HookDefinition } from "../hooks/types.js";
import type { CostTracker } from "../cost/tracker.js";
import type { Span } from "../tracing/types.js";
import { SpanStatusCode } from "../tracing/types.js";
import type { MemoryConfig } from "../memory/types.js";
import { extractMemories } from "../memory/extraction.js";
import { SessionStorage } from "../session/storage.js";
import { runNotificationHooks } from "../hooks/runner.js";
import type { StreamAccumulator } from "./consume-stream.js";

// ---------------------------------------------------------------------------
// In-loop finalization (no tool calls exit)
// ---------------------------------------------------------------------------

export interface FinalizeLoopExitParams {
  accumulator: StreamAccumulator;
  assistantMsg: AssistantMessage;
  outputFormat?: OutputFormat;
  isFinalResponseMode: boolean;
  turnUsage: ChatCompletionUsage;
  model: string;
  callCount: number;
  sessionId: string;
  costTracker?: CostTracker;
  hooks: HookDefinition[];
  storage: SessionStorage;
}

export interface FinalizeLoopExitResult {
  events: StreamEvent[];
}

export async function finalizeLoopExit(
  params: FinalizeLoopExitParams,
): Promise<FinalizeLoopExitResult> {
  const {
    accumulator, assistantMsg, outputFormat, isFinalResponseMode,
    turnUsage, model, callCount, sessionId, costTracker, hooks, storage,
  } = params;

  const events: StreamEvent[] = [];

  const textContent = accumulator.content.join("");
  if (outputFormat && !isFinalResponseMode && textContent) {
    try {
      const parsed = JSON.parse(textContent);
      events.push({
        type: "structured_output",
        data: parsed,
        schema: outputFormat,
      });
    } catch {
      // Model text wasn't valid JSON
    }
  }

  events.push({ type: "message_complete", message: assistantMsg });

  await runNotificationHooks(hooks, "TurnEnd", { event: "TurnEnd", sessionId });

  events.push({
    type: "turn_complete",
    usage: turnUsage,
    model,
    callCount,
  });

  if (costTracker) {
    await storage.appendMetadata(sessionId, "costState", costTracker.getState());
  }

  return { events };
}

// ---------------------------------------------------------------------------
// Post-loop teardown (memory extraction + span close + SessionEnd)
// ---------------------------------------------------------------------------

export interface FinalizeTurnParams {
  signal: AbortSignal;
  memoryConfig?: MemoryConfig;
  provider: AIProvider;
  model: string;
  messages: ChatMessage[];
  sessionId: string;
  callCount: number;
  maxTurns?: number;
  hooks: HookDefinition[];
  interactionSpan: Span;
  interactionStart: number;
}

export interface FinalizeTurnResult {
  events: StreamEvent[];
  earlyReturn: boolean;
}

export async function finalizeTurn(
  params: FinalizeTurnParams,
): Promise<FinalizeTurnResult> {
  const {
    signal, memoryConfig, provider, model, messages,
    sessionId, callCount, maxTurns, hooks,
    interactionSpan, interactionStart,
  } = params;

  const events: StreamEvent[] = [];

  if (signal.aborted) {
    interactionSpan.setStatus(SpanStatusCode.OK);
    interactionSpan.end();
    events.push({ type: "span_end", name: "noumen.interaction", spanId: sessionId, durationMs: Date.now() - interactionStart });
    await runNotificationHooks(hooks, "SessionEnd", {
      event: "SessionEnd",
      sessionId,
      reason: "abort",
    } as import("../hooks/types.js").SessionEndHookInput);
    return { events, earlyReturn: true };
  }

  const memCfg = memoryConfig;
  if (memCfg && memCfg.autoExtract && memCfg.provider) {
    try {
      const extractResult = await extractMemories(
        provider, model, messages, memCfg.provider,
      );
      const hasChanges = extractResult.created.length > 0
        || extractResult.updated.length > 0
        || extractResult.deleted.length > 0;
      if (hasChanges) {
        events.push({
          type: "memory_update",
          created: extractResult.created,
          updated: extractResult.updated,
          deleted: extractResult.deleted,
        });
        const allEntries = [
          ...extractResult.created.map((e) => ({ type: "created", content: e.content })),
          ...extractResult.updated.map((e) => ({ type: "updated", content: e.content })),
          ...extractResult.deleted.map((id) => ({ type: "deleted", content: id })),
        ];
        await runNotificationHooks(hooks, "MemoryUpdate", {
          event: "MemoryUpdate",
          sessionId,
          entries: allEntries,
        } as import("../hooks/types.js").MemoryUpdateHookInput);
      }
    } catch {
      // Memory extraction is best-effort
    }
  }

  interactionSpan.setStatus(SpanStatusCode.OK);
  interactionSpan.end();
  events.push({ type: "span_end", name: "noumen.interaction", spanId: sessionId, durationMs: Date.now() - interactionStart });

  const endReason: "complete" | "abort" | "maxTurns" = signal.aborted
    ? "abort"
    : (maxTurns !== undefined && callCount >= maxTurns)
      ? "maxTurns"
      : "complete";
  await runNotificationHooks(hooks, "SessionEnd", {
    event: "SessionEnd",
    sessionId,
    reason: endReason,
  } as import("../hooks/types.js").SessionEndHookInput);

  return { events, earlyReturn: false };
}
