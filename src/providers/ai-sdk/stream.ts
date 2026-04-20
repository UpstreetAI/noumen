/**
 * AI SDK v3 stream -> noumen `ChatStreamChunk` translation.
 *
 * Consumes a `ReadableStream<LanguageModelV3StreamPart>` produced by any
 * Vercel AI SDK provider and yields OpenAI-shaped chunks compatible with
 * the existing noumen pipeline:
 *
 *   text-delta       -> choices[0].delta.content
 *   reasoning-delta  -> choices[0].delta.thinking_content
 *   reasoning-end    -> choices[0].delta.{thinking_signature,redacted_thinking_data}
 *                       (reads Anthropic providerMetadata)
 *   tool-input-*     -> choices[0].delta.tool_calls[].function.arguments (streamed)
 *   tool-call        -> finalizes the tool-call (applies sanitize + repair)
 *   finish           -> terminal chunk with finish_reason + usage
 *   error            -> throws ChatStreamError via mapApiCallError
 */

import type { ChatStreamChunk } from "../types.js";
import { ChatStreamError } from "../types.js";
import { parseToolCallJson } from "./compat/json-repair.js";
import { mapApiCallError } from "./errors.js";

type Json = unknown;

interface StreamPartBase {
  type: string;
  providerMetadata?: Record<string, Record<string, Json>>;
  id?: string;
}

// We accept a loose shape because we support both v2 and v3 streams. The
// stream parts have the same discriminator values across both versions for
// the events we care about.
export type AiSdkStreamPart =
  | { type: "stream-start"; warnings?: unknown }
  | { type: "response-metadata"; id?: string; modelId?: string; timestamp?: Date }
  | { type: "text-start"; id: string; providerMetadata?: Record<string, Record<string, Json>> }
  | {
      type: "text-delta";
      id: string;
      delta: string;
      providerMetadata?: Record<string, Record<string, Json>>;
    }
  | { type: "text-end"; id: string; providerMetadata?: Record<string, Record<string, Json>> }
  | {
      type: "reasoning-start";
      id: string;
      providerMetadata?: Record<string, Record<string, Json>>;
    }
  | {
      type: "reasoning-delta";
      id: string;
      delta: string;
      providerMetadata?: Record<string, Record<string, Json>>;
    }
  | {
      type: "reasoning-end";
      id: string;
      providerMetadata?: Record<string, Record<string, Json>>;
    }
  | {
      type: "tool-input-start";
      id: string;
      toolName: string;
      providerMetadata?: Record<string, Record<string, Json>>;
      providerExecuted?: boolean;
      dynamic?: boolean;
    }
  | {
      type: "tool-input-delta";
      id: string;
      delta: string;
      providerMetadata?: Record<string, Record<string, Json>>;
    }
  | { type: "tool-input-end"; id: string; providerMetadata?: Record<string, Record<string, Json>> }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
      providerExecuted?: boolean;
      providerMetadata?: Record<string, Record<string, Json>>;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      result: Json;
      isError?: boolean;
      providerMetadata?: Record<string, Record<string, Json>>;
    }
  | {
      type: "finish";
      finishReason: string | { unified: string; raw?: string };
      usage: AiSdkUsage;
      providerMetadata?: Record<string, Record<string, Json>>;
    }
  | { type: "error"; error: unknown }
  | (StreamPartBase & { [k: string]: unknown });

/** Unified usage shape covering both V2 (flat) and V3 (nested). */
export type AiSdkUsage = {
  // V2 flat
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
} | {
  // V3 nested
  inputTokens: {
    total?: number;
    noCache?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  outputTokens: {
    total?: number;
    text?: number;
    reasoning?: number;
  };
  raw?: Record<string, Json>;
};

// ---------------------------------------------------------------------------
// Primary translator
// ---------------------------------------------------------------------------

/**
 * Transform an AI SDK stream into noumen's chunk protocol.
 *
 * @param stream the `LanguageModelV3StreamResult['stream']`
 * @param model  model id to stamp on each emitted chunk (matches legacy behavior)
 * @param signal optional abort signal; terminates iteration cleanly on abort
 */
export async function* translateStream(
  stream: ReadableStream<AiSdkStreamPart>,
  model: string,
  signal?: AbortSignal,
): AsyncIterable<ChatStreamChunk> {
  const reader = stream.getReader();
  const state = createState();

  try {
    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new ChatStreamError("aborted", { cause: signal.reason });
      }

      const { done, value: part } = await reader.read();
      if (done) break;

      for (const chunk of processStreamPart(part, state, model)) {
        yield chunk;
      }

      if (state.terminated) break;
    }
  } catch (err) {
    if (err instanceof ChatStreamError) throw err;
    throw mapApiCallError(err);
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

interface State {
  chunkIndex: number;
  toolIndexMap: Map<string, number>;
  toolNames: Map<string, string>;
  nextToolIndex: number;
  terminated: boolean;
}

function createState(): State {
  return {
    chunkIndex: 0,
    toolIndexMap: new Map(),
    toolNames: new Map(),
    nextToolIndex: 0,
    terminated: false,
  };
}

export function processStreamPart(
  part: AiSdkStreamPart,
  state: State,
  model: string,
): ChatStreamChunk[] {
  if (!part || typeof part !== "object") return [];
  const chunkId = `chatcmpl-${state.chunkIndex++}`;

  switch (part.type) {
    case "text-delta": {
      const delta = (part as { delta?: string }).delta;
      if (!delta) return [];
      return [makeChunk(chunkId, model, { content: delta })];
    }

    case "reasoning-delta": {
      const delta = (part as { delta?: string }).delta;
      if (!delta) return [];
      return [makeChunk(chunkId, model, { thinking_content: delta })];
    }

    case "reasoning-end": {
      // Anthropic packs the thinking signature (and redacted data) into
      // providerMetadata on the closing reasoning-end event; we lift both
      // onto the delta so the stored AssistantMessage round-trips.
      const meta = (part as {
        providerMetadata?: Record<string, Record<string, unknown>>;
      }).providerMetadata;
      const anthropicMeta = meta?.anthropic;
      if (!anthropicMeta) return [];

      const delta: Record<string, unknown> = {};
      if (typeof anthropicMeta.signature === "string") {
        delta.thinking_signature = anthropicMeta.signature;
      }
      if (typeof anthropicMeta.redactedData === "string") {
        delta.redacted_thinking_data = anthropicMeta.redactedData;
      }
      if (Object.keys(delta).length === 0) return [];
      return [makeChunk(chunkId, model, delta)];
    }

    case "tool-input-start": {
      const p = part as {
        id: string;
        toolName: string;
      };
      if (!p.id || !p.toolName) return [];
      if (state.toolIndexMap.has(p.id)) return [];
      const idx = state.nextToolIndex++;
      state.toolIndexMap.set(p.id, idx);
      state.toolNames.set(p.id, p.toolName);
      return [
        makeChunk(chunkId, model, {
          tool_calls: [
            {
              index: idx,
              id: p.id,
              type: "function",
              function: { name: p.toolName, arguments: "" },
            },
          ],
        }),
      ];
    }

    case "tool-input-delta": {
      const p = part as { id: string; delta: string };
      if (!p.delta) return [];
      let idx = state.toolIndexMap.get(p.id);
      if (idx === undefined) {
        // Some providers emit `tool-input-delta` without a prior `tool-input-start`.
        idx = state.nextToolIndex++;
        state.toolIndexMap.set(p.id, idx);
      }
      return [
        makeChunk(chunkId, model, {
          tool_calls: [
            {
              index: idx,
              function: { arguments: p.delta },
            },
          ],
        }),
      ];
    }

    case "tool-call": {
      // Terminal tool-call chunk. AI SDK providers emit this whether or not
      // a streaming `tool-input-*` sequence preceded it. The `input` here
      // is the canonical JSON string. If we already streamed deltas with
      // the raw JSON, we must NOT re-emit — downstream accumulators would
      // double-count. Check if we have seen this id stream; if so, skip.
      const p = part as {
        toolCallId: string;
        toolName: string;
        input: string;
      };
      if (state.toolIndexMap.has(p.toolCallId)) {
        // Already streamed; parse to validate but emit nothing. We rely on
        // the stream deltas to have carried the full JSON.
        return [];
      }

      // Non-streamed tool call — emit the whole thing in one go. Apply
      // the sanitize + repair pipeline before re-serializing so the
      // downstream accumulator gets valid JSON.
      const idx = state.nextToolIndex++;
      state.toolIndexMap.set(p.toolCallId, idx);
      state.toolNames.set(p.toolCallId, p.toolName);
      const parsed = parseToolCallJson(p.input);
      const argsString =
        parsed === null || parsed === undefined
          ? p.input ?? ""
          : JSON.stringify(parsed);

      return [
        makeChunk(chunkId, model, {
          tool_calls: [
            {
              index: idx,
              id: p.toolCallId,
              type: "function",
              function: { name: p.toolName, arguments: argsString },
            },
          ],
        }),
      ];
    }

    case "finish": {
      state.terminated = true;
      const p = part as {
        finishReason: string | { unified: string; raw?: string };
        usage: AiSdkUsage;
        providerMetadata?: Record<string, Record<string, unknown>>;
      };
      const finishReason = mapFinishReason(
        p.finishReason,
        state.toolIndexMap.size > 0,
      );
      const usage = mapUsage(p.usage, p.providerMetadata);
      return [
        {
          id: chunkId,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
          usage,
        },
      ];
    }

    case "error": {
      state.terminated = true;
      throw mapApiCallError((part as { error: unknown }).error);
    }

    // No-op events we simply drop. These still advance chunkIndex for
    // deterministic ids, matching mastra's approach.
    case "stream-start":
    case "response-metadata":
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "tool-input-end":
    case "tool-result":
    case "tool-approval-request":
    case "file":
    case "source":
    case "raw":
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Finish reason + usage mapping
// ---------------------------------------------------------------------------

function mapFinishReason(
  reason: string | { unified: string; raw?: string } | undefined,
  hasToolCalls: boolean,
): string {
  const unified =
    typeof reason === "object" && reason !== null && "unified" in reason
      ? reason.unified
      : reason ?? "other";

  switch (unified) {
    case "stop": return hasToolCalls ? "tool_calls" : "stop";
    case "length": return "length";
    case "content-filter": return "content_filter";
    case "tool-calls": return "tool_calls";
    case "error": return "error";
    case "other":
    case "unknown":
    default: return hasToolCalls ? "tool_calls" : "stop";
  }
}

function mapUsage(
  usage: AiSdkUsage | undefined,
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): ChatStreamChunk["usage"] {
  if (!usage) return undefined;

  let prompt = 0;
  let completion = 0;
  let cacheRead: number | undefined;
  let cacheCreation: number | undefined;
  let thinking: number | undefined;

  const nested =
    typeof (usage as { inputTokens?: unknown }).inputTokens === "object";

  if (nested) {
    const u = usage as Extract<AiSdkUsage, { inputTokens: { total?: number } }>;
    prompt = u.inputTokens.total ?? 0;
    completion = u.outputTokens.total ?? 0;
    cacheRead = u.inputTokens.cacheRead;
    cacheCreation = u.inputTokens.cacheWrite;
    thinking = u.outputTokens.reasoning;
  } else {
    const u = usage as Extract<AiSdkUsage, { inputTokens?: number }>;
    prompt = u.inputTokens ?? 0;
    completion = u.outputTokens ?? 0;
    thinking = u.reasoningTokens;
    cacheRead = u.cachedInputTokens;
  }

  // Anthropic sometimes only surfaces cache numbers via providerMetadata.
  if (providerMetadata) {
    const anth = providerMetadata.anthropic;
    if (anth) {
      if (cacheRead === undefined && typeof anth.cacheReadInputTokens === "number") {
        cacheRead = anth.cacheReadInputTokens;
      }
      if (
        cacheCreation === undefined &&
        typeof anth.cacheCreationInputTokens === "number"
      ) {
        cacheCreation = anth.cacheCreationInputTokens;
      }
    }
    const openai = providerMetadata.openai;
    if (openai && cacheRead === undefined && typeof openai.cachedPromptTokens === "number") {
      cacheRead = openai.cachedPromptTokens;
    }
  }

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    thinking_tokens: thinking,
  };
}

// ---------------------------------------------------------------------------
// Chunk builder (kept local so the module is self-contained)
// ---------------------------------------------------------------------------

function makeChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
): ChatStreamChunk {
  return {
    id,
    model,
    choices: [
      {
        index: 0,
        delta: delta as ChatStreamChunk["choices"][0]["delta"],
        finish_reason: null,
      },
    ],
  };
}
