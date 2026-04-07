import type {
  AIProvider,
  ChatCompletionUsage,
  ChatStreamChunk,
  OutputFormat,
  ToolDefinition,
} from "../providers/types.js";
import type {
  ChatMessage,
  AssistantMessage,
  ToolCallContent,
  StreamEvent,
} from "../session/types.js";
import type { HookDefinition } from "../hooks/types.js";
import type { ThinkingConfig } from "../thinking/types.js";
import type { RetryConfig } from "../retry/types.js";
import type { CostTracker } from "../cost/tracker.js";
import type { Tracer, Span } from "../tracing/types.js";
import { SpanStatusCode } from "../tracing/types.js";
import type { ReactiveCompactConfig } from "../compact/reactive-compact.js";
import type { AutoCompactTrackingState } from "../compact/auto-compact.js";
import { recordAutoCompactSuccess } from "../compact/auto-compact.js";
import type { Tool } from "../tools/types.js";
import {
  StreamingToolExecutor,
  type StreamingExecResult,
  type StreamingToolExecutorFn,
} from "../tools/streaming-executor.js";
import { SessionStorage } from "../session/storage.js";
import { runNotificationHooks } from "../hooks/runner.js";
import { withRetry, CannotRetryError } from "../retry/engine.js";
import { classifyError } from "../retry/classify.js";
import {
  createAccumulator,
  resetAccumulator,
  consumeStream,
  handleFinishReason,
  type StreamAccumulator,
} from "./consume-stream.js";
import {
  separateToolCalls,
  buildAssistantMessage,
  generateMalformedToolResults,
  accumulateUsage,
} from "./build-assistant-response.js";
import {
  buildPartialResults,
  tryReactiveCompactRecovery as tryReactiveCompactRecoveryFn,
} from "./error-recovery.js";
import { sortToolDefinitionsForCache } from "../providers/cache.js";
import { saveCacheSafeParams, createCacheSafeParams } from "../providers/cache-safe-params.js";
import { generateUUID } from "../utils/uuid.js";
import {
  createBudgetState,
  type BudgetState,
} from "../compact/tool-result-budget.js";
import { createContentReplacementState } from "../compact/tool-result-storage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderRoundParams {
  messages: ChatMessage[];
  storage: SessionStorage;
  sessionId: string;
  provider: AIProvider;
  model: string;
  messagesForApi: ChatMessage[];
  systemPrompt: string;
  toolDefs: ToolDefinition[];
  maxTokens: number | undefined;
  thinking: ThinkingConfig | undefined;
  retryConfig: RetryConfig | undefined;
  promptCachingEnabled: boolean;
  skipCacheWrite: boolean | undefined;
  outputFormat: OutputFormat | undefined;
  isFinalResponseMode: boolean;
  useStreamingExec: boolean;
  signal: AbortSignal;
  tracer: Tracer;
  parentSpan: Span;
  hooks: HookDefinition[];
  toolRegistryLookup: (name: string) => Tool | undefined;
  buildStreamingExecutorFn: StreamingToolExecutorFn;
  reactiveCompact: ReactiveCompactConfig | undefined;
  hasAttemptedReactiveCompact: boolean;
  autoCompactTracking: AutoCompactTrackingState;
  mcpToolNames?: ReadonlySet<string>;
  costTracker?: CostTracker;
  turnUsage: ChatCompletionUsage;
  callCount: number;
  consecutiveMalformedIterations: number;
  preventContinuation: boolean;
  currentMaxTokens: number | undefined;
  outputTokenRecoveryAttempts: number;
  maxTurns: number | undefined;
}

export interface ProviderRoundResult {
  shouldContinueOuterLoop: boolean;
  shouldBreakOuterLoop: boolean;
  accumulator: StreamAccumulator;
  assistantMsg: AssistantMessage | null;
  toolCalls: ToolCallContent[];
  malformedToolCalls: Array<{ id: string; name: string }>;
  streamingResults: StreamingExecResult[];
  streamingExec: StreamingToolExecutor | null;
  model: string;
  callCount: number;
  consecutiveMalformedIterations: number;
  preventContinuation: boolean;
  currentMaxTokens: number | undefined;
  outputTokenRecoveryAttempts: number;
  lastUsage: ChatCompletionUsage | undefined;
  anchorMessageIndex: number | undefined;
  microcompactTokensFreed: number;
  hasAttemptedReactiveCompact: boolean;
  /** When reactive compact recovered, the new messages to replace thread messages. */
  compactRecovered: boolean;
  recoveredMessages?: ChatMessage[];
  /** State resets triggered by compact recovery (budget, content replacement, etc). */
  compactStateReset: boolean;
}

const MAX_CONSECUTIVE_MALFORMED = 5;

// ---------------------------------------------------------------------------
// Provider round — async generator
// ---------------------------------------------------------------------------

export async function* executeProviderRound(
  p: ProviderRoundParams,
): AsyncGenerator<StreamEvent, ProviderRoundResult> {
  let {
    model,
    callCount,
    consecutiveMalformedIterations,
    preventContinuation,
    currentMaxTokens,
    outputTokenRecoveryAttempts,
    hasAttemptedReactiveCompact,
  } = p;

  const {
    messages, storage, sessionId, provider, messagesForApi,
    systemPrompt, toolDefs, thinking, retryConfig, skipCacheWrite,
    promptCachingEnabled, outputFormat, isFinalResponseMode,
    useStreamingExec, signal, tracer, parentSpan, hooks,
    toolRegistryLookup, buildStreamingExecutorFn, reactiveCompact,
    autoCompactTracking, mcpToolNames, costTracker, turnUsage,
    maxTurns,
  } = p;

  let lastUsage: ChatCompletionUsage | undefined;
  let anchorMessageIndex: number | undefined;
  let microcompactTokensFreed = 0;

  const base = (): ProviderRoundResult => ({
    shouldContinueOuterLoop: false,
    shouldBreakOuterLoop: false,
    accumulator: createAccumulator(),
    assistantMsg: null,
    toolCalls: [],
    malformedToolCalls: [],
    streamingResults: [],
    streamingExec: null,
    model,
    callCount,
    consecutiveMalformedIterations,
    preventContinuation,
    currentMaxTokens,
    outputTokenRecoveryAttempts,
    lastUsage,
    anchorMessageIndex,
    microcompactTokensFreed,
    hasAttemptedReactiveCompact,
    compactRecovered: false,
    compactStateReset: false,
  });

  // --- TurnStart notification ---
  await runNotificationHooks(hooks, "TurnStart", {
    event: "TurnStart",
    sessionId,
    messages,
  });

  const accumulator = createAccumulator();

  let streamingExec: StreamingToolExecutor | null = null;
  const streamingResults: StreamingExecResult[] = [];

  if (useStreamingExec) {
    streamingExec = new StreamingToolExecutor(
      toolRegistryLookup,
      buildStreamingExecutorFn,
      signal,
    );
  }

  const sortedToolDefs = promptCachingEnabled
    ? sortToolDefinitionsForCache(toolDefs, mcpToolNames)
    : toolDefs;

  const chatParams = {
    model,
    messages: messagesForApi,
    tools: sortedToolDefs,
    system: systemPrompt,
    max_tokens: currentMaxTokens,
    thinking,
    skipCacheWrite,
    signal,
    ...(outputFormat && !isFinalResponseMode ? { outputFormat } : {}),
  };

  let stream: AsyncIterable<ChatStreamChunk>;

  const providerSpanId = generateUUID();
  const providerSpan = tracer.startSpan("noumen.provider.chat", {
    parent: parentSpan,
    attributes: {
      "model": model,
      "messages.count": messages.length,
      "tools.count": toolDefs.length,
    },
  });
  yield { type: "span_start", name: "noumen.provider.chat", spanId: providerSpanId };
  const providerStart = Date.now();

  try {
    if (retryConfig) {
      const retryGen = withRetry(
        (ctx) => {
          const params = { ...chatParams };
          if (ctx.maxTokensOverride !== undefined) {
            params.max_tokens = ctx.maxTokensOverride;
          }
          if (ctx.model !== chatParams.model) {
            params.model = ctx.model;
          }
          return provider.chat(params);
        },
        {
          ...retryConfig,
          model,
          thinkingBudget:
            thinking?.type === "enabled"
              ? thinking.budgetTokens
              : undefined,
          signal,
        },
      );

      let retryResult = await retryGen.next();
      while (!retryResult.done) {
        const event = retryResult.value;
        if (event.type === "model_switch") {
          const sw = event as { type: "model_switch"; from: string; to: string };
          model = sw.to;
          stripThinkingSignatures(messages);
          resetAccumulator(accumulator);
          if (streamingExec) {
            streamingExec.discard();
            streamingExec = new StreamingToolExecutor(
              toolRegistryLookup,
              buildStreamingExecutorFn,
              signal,
            );
          }
          streamingResults.length = 0;
          if (hooks.length > 0) {
            await runNotificationHooks(hooks, "ModelSwitch", {
              event: "ModelSwitch",
              sessionId,
              previousModel: sw.from,
              newModel: sw.to,
            } as import("../hooks/types.js").ModelSwitchHookInput);
          }
        }
        if (event.type === "retry_attempt" && hooks.length > 0) {
          const re = event as { attempt: number; maxRetries: number; delayMs: number; error: Error };
          await runNotificationHooks(hooks, "RetryAttempt", {
            event: "RetryAttempt",
            sessionId,
            attempt: re.attempt,
            maxAttempts: re.maxRetries,
            error: re.error.message,
            delay: re.delayMs,
          } as import("../hooks/types.js").RetryAttemptHookInput);
        }
        yield event;
        retryResult = await retryGen.next();
      }

      stream = retryResult.value;
    } else {
      stream = provider.chat(chatParams);
    }
  } catch (providerErr) {
    const completedBeforeError: StreamingExecResult[] = [];
    if (streamingExec) {
      for (const result of streamingExec.getCompletedResults()) {
        completedBeforeError.push(result);
      }
      streamingExec.discard();
    }

    const isOverflow =
      (providerErr instanceof CannotRetryError &&
        classifyError(providerErr.originalError).isContextOverflow) ||
      (!retryConfig && classifyError(providerErr).isContextOverflow);

    if (
      isOverflow &&
      reactiveCompact?.enabled &&
      !hasAttemptedReactiveCompact
    ) {
      hasAttemptedReactiveCompact = true;
      providerSpan.setStatus(SpanStatusCode.ERROR, "context overflow — reactive compact");
      providerSpan.end();
      yield { type: "span_end", name: "noumen.provider.chat", spanId: providerSpanId, durationMs: Date.now() - providerStart, error: "context overflow" };

      const recovery = await tryReactiveCompactRecoveryFn({
        provider,
        model,
        messages,
        storage,
        sessionId,
        signal,
        hooks,
      });
      for (const evt of recovery.events) yield evt;
      if (recovery.recovered) {
        recordAutoCompactSuccess(autoCompactTracking);
        return {
          ...base(),
          shouldContinueOuterLoop: true,
          hasAttemptedReactiveCompact,
          compactRecovered: true,
          recoveredMessages: recovery.messages!,
          compactStateReset: true,
          streamingExec,
          accumulator,
        };
      }
    }

    const errorReason = `Provider error: ${providerErr instanceof Error ? providerErr.message : String(providerErr)}`;
    const partial = buildPartialResults({
      accumulatedToolCalls: accumulator.toolCalls,
      accumulatedContent: accumulator.content,
      completedStreamingResults: completedBeforeError,
      reason: errorReason,
      existingMessages: messages,
    });
    for (const msg of partial.messages) {
      messages.push(msg);
      await storage.appendMessage(sessionId, msg);
    }

    providerSpan.setStatus(SpanStatusCode.ERROR, providerErr instanceof Error ? providerErr.message : String(providerErr));
    providerSpan.end();
    yield { type: "span_end", name: "noumen.provider.chat", spanId: providerSpanId, durationMs: Date.now() - providerStart, error: String(providerErr) };

    throw providerErr;
  }

  const apiStartTime = Date.now();

  try {
    for await (const evt of consumeStream(stream, accumulator, streamingExec, streamingResults, signal)) {
      yield evt;
    }
  } catch (streamErr) {
    const streamCompletedResults: StreamingExecResult[] = [];
    if (streamingExec) {
      for (const result of streamingExec.getCompletedResults()) {
        streamCompletedResults.push(result);
      }
      streamingExec.discard();
    }
    const streamErrReason = `Stream error: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`;
    const partial = buildPartialResults({
      accumulatedToolCalls: accumulator.toolCalls,
      accumulatedContent: accumulator.content,
      completedStreamingResults: streamCompletedResults,
      reason: streamErrReason,
    });
    for (const msg of partial.messages) {
      messages.push(msg);
      await storage.appendMessage(sessionId, msg);
    }
    throw streamErr;
  }

  const apiDurationMs = Date.now() - apiStartTime;

  // Abort check
  if (signal.aborted) {
    providerSpan.setStatus(SpanStatusCode.OK);
    providerSpan.end();
    yield { type: "span_end", name: "noumen.provider.chat", spanId: providerSpanId, durationMs: Date.now() - providerStart };

    if (streamingExec) {
      streamingExec.discard();
      for await (const result of streamingExec.getRemainingResults()) {
        streamingResults.push(result);
      }
    }

    const abortPartial = buildPartialResults({
      accumulatedToolCalls: accumulator.toolCalls,
      accumulatedContent: accumulator.content,
      completedStreamingResults: streamingResults,
      reason: "abort",
      includeInterruptionTag: false,
    });
    for (const msg of abortPartial.messages) {
      messages.push(msg);
      await storage.appendMessage(sessionId, msg).catch((err) => {
        console.warn("[noumen/thread] Failed to persist abort message:", err);
      });
    }

    const interruptionMsg: ChatMessage = {
      role: "user",
      content: "[Session interrupted by user. Continue from where you left off if resumed.]",
    };
    messages.push(interruptionMsg);
    await storage.appendMessage(sessionId, interruptionMsg).catch(() => {});

    return {
      ...base(),
      shouldBreakOuterLoop: true,
      accumulator,
      streamingResults,
      streamingExec,
    };
  }

  // Finish reason
  const frResult = handleFinishReason(
    accumulator, streamingExec, streamingResults,
    currentMaxTokens, outputTokenRecoveryAttempts, signal,
  );
  for (const evt of frResult.events) yield evt;
  for (const msg of frResult.messagesToPersist) {
    messages.push(msg);
    await storage.appendMessage(sessionId, msg).catch(() => {});
  }
  if (frResult.escalateMaxTokens !== undefined) currentMaxTokens = frResult.escalateMaxTokens;
  if (frResult.shouldContinue) {
    outputTokenRecoveryAttempts++;
    streamingExec?.discard();
    accumulator.toolCalls.clear();
    return {
      ...base(),
      shouldContinueOuterLoop: true,
      accumulator,
      currentMaxTokens,
      outputTokenRecoveryAttempts,
      streamingResults,
      streamingExec,
    };
  }
  if (frResult.preventContinuation) preventContinuation = true;

  // Usage accumulation
  callCount++;
  const usageResult = accumulateUsage({
    usage: accumulator.usage,
    turnUsage,
    model,
    messagesLength: messages.length,
  });
  for (const evt of usageResult.events) yield evt;
  if (usageResult.lastUsage) {
    lastUsage = usageResult.lastUsage;
    anchorMessageIndex = usageResult.anchorMessageIndex!;
    microcompactTokensFreed = 0;

    if (costTracker) {
      const summary = costTracker.addUsage(model, usageResult.lastUsage, apiDurationMs);
      yield { type: "cost_update", summary };

      await storage.appendMetadata(
        sessionId,
        "costState",
        costTracker.getState(),
      ).catch(() => {});
    }

    providerSpan.setAttribute("tokens.input", usageResult.lastUsage.prompt_tokens);
    providerSpan.setAttribute("tokens.output", usageResult.lastUsage.completion_tokens);
  }

  if (promptCachingEnabled) {
    saveCacheSafeParams(
      createCacheSafeParams({
        systemPrompt,
        model,
        tools: sortedToolDefs,
        thinking,
      }),
      sessionId,
    );
  }

  providerSpan.setStatus(SpanStatusCode.OK);
  providerSpan.end();
  yield { type: "span_end", name: "noumen.provider.chat", spanId: providerSpanId, durationMs: Date.now() - providerStart };

  // Build assistant message
  const { valid: toolCalls, malformed: malformedToolCalls } = separateToolCalls(accumulator, !!streamingExec);

  const assistantMsg = buildAssistantMessage({
    acc: accumulator,
    validToolCalls: toolCalls,
    malformedToolCalls,
    turnId: `${sessionId}:${callCount}`,
  });
  messages.push(assistantMsg);
  await storage.appendMessage(sessionId, assistantMsg);

  const malformedResult = generateMalformedToolResults(malformedToolCalls);
  for (const msg of malformedResult.messages) {
    messages.push(msg);
    await storage.appendMessage(sessionId, msg);
  }
  for (const evt of malformedResult.events) yield evt;

  // Malformed-only handling
  if (toolCalls.length === 0 && malformedToolCalls.length > 0) {
    consecutiveMalformedIterations++;
    if (consecutiveMalformedIterations >= MAX_CONSECUTIVE_MALFORMED) {
      yield { type: "error", error: new Error(`Exceeded ${MAX_CONSECUTIVE_MALFORMED} consecutive malformed tool call attempts`) };
      return {
        ...base(),
        shouldBreakOuterLoop: true,
        accumulator,
        assistantMsg,
        toolCalls,
        malformedToolCalls,
        streamingResults,
        streamingExec,
        callCount,
        consecutiveMalformedIterations,
      };
    }
    if (maxTurns !== undefined && callCount >= maxTurns) {
      await runNotificationHooks(hooks, "TurnEnd", { event: "TurnEnd", sessionId });
      yield { type: "turn_complete", usage: turnUsage, model, callCount };
      yield { type: "max_turns_reached", maxTurns, turnCount: callCount };
      return {
        ...base(),
        shouldBreakOuterLoop: true,
        accumulator,
        assistantMsg,
        toolCalls,
        malformedToolCalls,
        streamingResults,
        streamingExec,
        callCount,
        consecutiveMalformedIterations,
      };
    }
    await runNotificationHooks(hooks, "TurnEnd", { event: "TurnEnd", sessionId });
    return {
      ...base(),
      shouldContinueOuterLoop: true,
      accumulator,
      assistantMsg,
      toolCalls,
      malformedToolCalls,
      streamingResults,
      streamingExec,
      callCount,
      consecutiveMalformedIterations,
    };
  }

  // Normal result — caller decides what to do with tool calls
  return {
    ...base(),
    accumulator,
    assistantMsg,
    toolCalls,
    malformedToolCalls,
    streamingResults,
    streamingExec,
    callCount,
    consecutiveMalformedIterations,
    preventContinuation,
    lastUsage,
    anchorMessageIndex,
    microcompactTokensFreed,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function stripThinkingSignatures(messages: ChatMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const asst = msg as AssistantMessage;
    if (asst.thinking_signature) delete asst.thinking_signature;
    if (asst.redacted_thinking_data) delete asst.redacted_thinking_data;
  }
}
