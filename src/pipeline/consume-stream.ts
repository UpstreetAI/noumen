import type { ChatStreamChunk, ChatCompletionUsage } from "../providers/types.js";
import type { StreamEvent, ChatMessage, AssistantMessage } from "../session/types.js";
import type { StreamingToolExecutor, StreamingExecResult } from "../tools/streaming-executor.js";

// ---------------------------------------------------------------------------
// StreamAccumulator — mutable state populated by consumeStream
// ---------------------------------------------------------------------------

export interface ToolCallEntry {
  id: string;
  name: string;
  arguments: string;
  complete: boolean;
  malformedJson?: boolean;
  startEmitted?: boolean;
}

export interface StreamAccumulator {
  content: string[];
  thinking: string[];
  thinkingSignature: string | undefined;
  redactedThinkingData: string | undefined;
  toolCalls: Map<number, ToolCallEntry>;
  finishReason: string | null;
  usage: ChatCompletionUsage | undefined;
}

export function createAccumulator(): StreamAccumulator {
  return {
    content: [],
    thinking: [],
    thinkingSignature: undefined,
    redactedThinkingData: undefined,
    toolCalls: new Map(),
    finishReason: null,
    usage: undefined,
  };
}

export function resetAccumulator(acc: StreamAccumulator): void {
  acc.content.length = 0;
  acc.thinking.length = 0;
  acc.thinkingSignature = undefined;
  acc.redactedThinkingData = undefined;
  acc.toolCalls.clear();
  acc.finishReason = null;
  acc.usage = undefined;
}

// ---------------------------------------------------------------------------
// consumeStream — iterate provider chunks, populate accumulator, yield events
// ---------------------------------------------------------------------------

export async function* consumeStream(
  stream: AsyncIterable<ChatStreamChunk>,
  acc: StreamAccumulator,
  streamingExec: StreamingToolExecutor | null,
  streamingResults: StreamingExecResult[],
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  for await (const chunk of stream) {
    if (signal.aborted) break;

    if (chunk.usage) {
      acc.usage = chunk.usage;
    }

    for (const choice of chunk.choices) {
      if (choice.finish_reason) {
        acc.finishReason = choice.finish_reason;
      }

      const delta = choice.delta;

      if (delta.thinking_content) {
        acc.thinking.push(delta.thinking_content);
        yield { type: "thinking_delta", text: delta.thinking_content } as StreamEvent;
      }

      if (delta.thinking_signature) {
        acc.thinkingSignature = (acc.thinkingSignature ?? "") + delta.thinking_signature;
      }

      if (delta.redacted_thinking_data) {
        acc.redactedThinkingData = (acc.redactedThinkingData ?? "") + delta.redacted_thinking_data;
      }

      if (delta.content) {
        acc.content.push(delta.content);
        yield { type: "text_delta", text: delta.content } as StreamEvent;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = acc.toolCalls.get(tc.index);

          if (!existing) {
            const id = tc.id ?? "";
            const name = tc.function?.name ?? "";
            const startEmitted = !!(tc.id && tc.function?.name);
            acc.toolCalls.set(tc.index, {
              id,
              name,
              arguments: tc.function?.arguments ?? "",
              complete: false,
              startEmitted,
            });

            if (startEmitted) {
              yield { type: "tool_use_start", toolName: name, toolUseId: id } as StreamEvent;
            }

            if (streamingExec && tc.index > 0) {
              const prevTc = acc.toolCalls.get(tc.index - 1);
              if (prevTc && !prevTc.complete) {
                prevTc.complete = true;
                try {
                  const parsedArgs = JSON.parse(prevTc.arguments);
                  streamingExec.addTool(
                    { id: prevTc.id, type: "function", function: { name: prevTc.name, arguments: prevTc.arguments } },
                    parsedArgs,
                  );
                } catch {
                  prevTc.malformedJson = true;
                }
              }
            }
          } else {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (!existing.startEmitted && existing.id && existing.name) {
              existing.startEmitted = true;
              yield { type: "tool_use_start", toolName: existing.name, toolUseId: existing.id } as StreamEvent;
            }
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
              yield { type: "tool_use_delta", input: tc.function.arguments } as StreamEvent;
            }
          }
        }
      }
    }

    if (streamingExec) {
      for (const result of streamingExec.getCompletedResults()) {
        streamingResults.push(result);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// handleFinishReason — process finish_reason, return control-flow signals
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 8192;
const ESCALATED_MAX_TOKENS = 65536;
const MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;

export interface FinishReasonResult {
  events: StreamEvent[];
  messagesToPersist: ChatMessage[];
  preventContinuation: boolean;
  shouldContinue: boolean;
  escalateMaxTokens?: number;
}

export function handleFinishReason(
  acc: StreamAccumulator,
  streamingExec: StreamingToolExecutor | null,
  streamingResults: StreamingExecResult[],
  currentMaxTokens: number | undefined,
  outputTokenRecoveryAttempts: number,
  signal: AbortSignal,
): FinishReasonResult {
  const events: StreamEvent[] = [];
  const messagesToPersist: ChatMessage[] = [];
  let preventContinuation = false;
  let shouldContinue = false;
  let escalateMaxTokens: number | undefined;

  if (acc.finishReason === "length" && acc.toolCalls.size === 0) {
    const canEscalate =
      (currentMaxTokens === undefined || currentMaxTokens === DEFAULT_MAX_TOKENS) &&
      outputTokenRecoveryAttempts === 0;

    if (canEscalate || outputTokenRecoveryAttempts < MAX_OUTPUT_RECOVERY_ATTEMPTS) {
      if (canEscalate) {
        escalateMaxTokens = ESCALATED_MAX_TOKENS;
      }
      shouldContinue = true;
      const partialContent = acc.content.join("");
      if (partialContent) {
        messagesToPersist.push({
          role: "assistant",
          content: partialContent,
        } as AssistantMessage);
        messagesToPersist.push({
          role: "user",
          content: "Continue from where you left off — no apology, no recap.",
        } as ChatMessage);
      }
    } else {
      events.push({ type: "text_delta", text: "\n\n[Response truncated due to max output tokens]" } as StreamEvent);
    }
  }

  if (acc.finishReason === "content_filter") {
    events.push({ type: "text_delta", text: "\n\n[Response blocked by content filter]" } as StreamEvent);
    if (streamingExec) {
      for (const result of streamingExec.getCompletedResults()) {
        streamingResults.push(result);
      }
      streamingExec.discard();
      preventContinuation = true;
    } else {
      acc.toolCalls.clear();
    }
  }

  if (streamingExec && !signal.aborted && !shouldContinue) {
    for (const [, tc] of acc.toolCalls) {
      if (!tc.complete) {
        tc.complete = true;
        try {
          const parsedArgs = JSON.parse(tc.arguments);
          streamingExec.addTool(
            { id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } },
            parsedArgs,
          );
        } catch {
          tc.malformedJson = true;
        }
      }
    }
  }

  return {
    events,
    messagesToPersist,
    preventContinuation,
    shouldContinue,
    ...(escalateMaxTokens !== undefined ? { escalateMaxTokens } : {}),
  };
}
