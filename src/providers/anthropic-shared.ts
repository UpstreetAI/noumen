/**
 * Shared Anthropic streaming, message conversion, and tool mapping logic.
 *
 * Used by AnthropicProvider, BedrockAnthropicProvider, and VertexAnthropicProvider.
 * Accepts a generic client shape so it works with all three SDKs without
 * importing any of them directly.
 */

import type { ChatParams, ChatStreamChunk } from "./types.js";
import { ChatStreamError } from "./types.js";
import type { ChatMessage, ContentPart } from "../session/types.js";
import type { CacheControlConfig } from "./cache.js";
import { getMessageCacheBreakpointIndex } from "./cache.js";
import { getMaxOutputTokensForModel } from "../utils/context.js";

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type CacheControlBlock = {
  type: "ephemeral";
  ttl?: "1h";
  scope?: "global" | "org";
};

export interface AnthropicStreamClient {
  messages: {
    stream(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<Record<string, unknown>>;
  };
}

export function buildCacheControlBlock(
  config: CacheControlConfig | undefined,
): CacheControlBlock {
  const cc: CacheControlBlock = { type: "ephemeral" };
  if (config?.ttl) cc.ttl = config.ttl;
  if (config?.scope) cc.scope = config.scope;
  return cc;
}

function isCachingEnabled(config: CacheControlConfig | undefined): boolean {
  return config?.enabled === true;
}

export function contentPartsToAnthropic(
  parts: ContentPart[],
): Record<string, unknown>[] {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.media_type,
          data: part.data,
        },
      };
    }
    return {
      type: "image",
      source: { type: "url", url: part.url },
    };
  });
}

export function buildAnthropicTools(
  params: ChatParams,
  cacheConfig?: CacheControlConfig,
): Record<string, unknown>[] | undefined {
  if (!params.tools) return undefined;

  const tools = params.tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  if (isCachingEnabled(cacheConfig) && tools.length > 0) {
    const lastTool = tools[tools.length - 1] as Record<string, unknown>;
    lastTool.cache_control = buildCacheControlBlock(cacheConfig);
  }

  return tools;
}

export function buildAnthropicSystemBlocks(
  systemPrompt: string | undefined,
  cacheConfig?: CacheControlConfig,
): unknown {
  if (!systemPrompt) return undefined;
  if (!isCachingEnabled(cacheConfig)) return systemPrompt;

  return [
    {
      type: "text",
      text: systemPrompt,
      cache_control: buildCacheControlBlock(cacheConfig),
    },
  ];
}

export function convertAnthropicMessages(
  systemPrompt: string | undefined,
  messages: ChatMessage[],
  cacheConfig?: CacheControlConfig,
  skipCacheWrite?: boolean,
): {
  system: unknown;
  messages: Record<string, unknown>[];
} {
  const result: Record<string, unknown>[] = [];
  const caching = isCachingEnabled(cacheConfig);
  const cacheBreakpointIdx = caching
    ? getMessageCacheBreakpointIndex(messages, skipCacheWrite)
    : -1;

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const addCache = mi === cacheBreakpointIdx;

    if (msg.role === "system") continue;

    if (msg.role === "user") {
      const isMultipart = Array.isArray(msg.content);
      if (addCache && caching) {
        const blocks = isMultipart
          ? contentPartsToAnthropic(msg.content as ContentPart[])
          : [{ type: "text", text: msg.content as string }];
        const lastBlock = blocks[blocks.length - 1] as Record<string, unknown>;
        lastBlock.cache_control = buildCacheControlBlock(cacheConfig);
        result.push({ role: "user", content: blocks });
      } else if (isMultipart) {
        result.push({
          role: "user",
          content: contentPartsToAnthropic(msg.content as ContentPart[]),
        });
      } else {
        result.push({ role: "user", content: msg.content as string });
      }
    } else if (msg.role === "assistant") {
      const content: Record<string, unknown>[] = [];
      if (msg.thinking_content) {
        const thinkingBlock: Record<string, unknown> = {
          type: "thinking",
          thinking: msg.thinking_content,
        };
        if (msg.thinking_signature) {
          thinkingBlock.signature = msg.thinking_signature;
        }
        content.push(thinkingBlock);
      }
      if (msg.redacted_thinking_data) {
        content.push({
          type: "redacted_thinking",
          data: msg.redacted_thinking_data,
        });
      }
      if (msg.content && (typeof msg.content !== "string" || msg.content.trim() !== "")) {
        content.push({ type: "text", text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            // malformed JSON from truncated stream — send empty input
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }
      if (addCache && caching && content.length > 0) {
        for (let i = content.length - 1; i >= 0; i--) {
          const block = content[i] as Record<string, unknown>;
          if (block.type !== "thinking" && block.type !== "redacted_thinking") {
            block.cache_control = buildCacheControlBlock(cacheConfig);
            break;
          }
        }
      }
      result.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      const isMultipart = Array.isArray(msg.content);
      let toolContent: string | Record<string, unknown>[];

      if (msg.isError && isMultipart) {
        const textOnly = (msg.content as ContentPart[]).filter(
          (p) => p.type === "text",
        );
        toolContent =
          textOnly.length > 0
            ? contentPartsToAnthropic(textOnly)
            : String(msg.content);
      } else {
        toolContent = isMultipart
          ? contentPartsToAnthropic(msg.content as ContentPart[])
          : (msg.content as string);
      }

      const toolResultBlock: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: toolContent,
      };
      if (msg.isError) {
        toolResultBlock.is_error = true;
      }
      if (addCache && caching) {
        toolResultBlock.cache_control = buildCacheControlBlock(cacheConfig);
      }

      const prev = result[result.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        const blocks = prev.content as Record<string, unknown>[];
        if (blocks.length > 0 && blocks[0].type === "tool_result") {
          blocks.push(toolResultBlock);
          continue;
        }
      }
      result.push({ role: "user", content: [toolResultBlock] });
    }
  }

  return {
    system: buildAnthropicSystemBlocks(systemPrompt, cacheConfig),
    messages: result,
  };
}

export function makeChunk(
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

// ---------------------------------------------------------------------------
// buildAnthropicRequestParams — pure param construction
// ---------------------------------------------------------------------------

export interface AnthropicRequestParamsResult {
  streamParams: Record<string, unknown>;
  model: string;
}

export function buildAnthropicRequestParams(
  params: ChatParams,
  defaultModel: string,
  cacheConfig?: CacheControlConfig,
): AnthropicRequestParamsResult {
  const { system, messages: inputMessages } = convertAnthropicMessages(
    params.system,
    params.messages,
    cacheConfig,
    params.skipCacheWrite,
  );

  const tools = buildAnthropicTools(params, cacheConfig);

  const thinkingEnabled =
    params.thinking?.type === "enabled" &&
    (params.thinking as { budgetTokens: number }).budgetTokens > 0;
  const budgetTokens = thinkingEnabled
    ? (params.thinking as { type: "enabled"; budgetTokens: number }).budgetTokens
    : 0;

  const model = params.model ?? defaultModel;

  const modelMaxOutput = getMaxOutputTokensForModel(model);
  const maxOutputTokens = thinkingEnabled
    ? (params.max_tokens ?? modelMaxOutput)
    : (params.max_tokens ?? 8192);
  const clampedBudget = thinkingEnabled
    ? Math.min(budgetTokens, maxOutputTokens - 1)
    : 0;

  const streamParams: Record<string, unknown> = {
    model,
    max_tokens: maxOutputTokens,
    system,
    messages: inputMessages,
    tools,
  };

  if (!thinkingEnabled && params.temperature !== undefined) {
    streamParams.temperature = params.temperature;
  }

  if (thinkingEnabled) {
    streamParams.thinking = {
      type: "enabled",
      budget_tokens: clampedBudget,
    };
  }

  if (params.outputFormat?.type === "json_schema") {
    streamParams.output_config = {
      format: {
        type: "json_schema",
        json_schema: {
          name: params.outputFormat.name ?? "response",
          schema: params.outputFormat.schema,
        },
      },
    };
    const betas: string[] = (streamParams.betas as string[] | undefined) ?? [];
    if (!betas.includes("structured-outputs-2025-12-15")) {
      betas.push("structured-outputs-2025-12-15");
    }
    streamParams.betas = betas;
  } else if (params.outputFormat?.type === "json_object") {
    const hint = "\n\nYou MUST respond with valid JSON only. No markdown, no explanation — just a single JSON object.";
    if (typeof streamParams.system === "string") {
      streamParams.system = streamParams.system + hint;
    } else if (Array.isArray(streamParams.system)) {
      const blocks = streamParams.system as Array<Record<string, unknown>>;
      if (blocks.length > 0) {
        const last = blocks[blocks.length - 1];
        if (last.type === "text" && typeof last.text === "string") {
          last.text = last.text + hint;
        }
      }
    } else if (!streamParams.system) {
      streamParams.system = hint.trim();
    }
  }

  return { streamParams, model };
}

// ---------------------------------------------------------------------------
// mapAnthropicStopReason — pure stop_reason -> finish_reason mapping
// ---------------------------------------------------------------------------

export function mapAnthropicStopReason(
  stopReason: string | undefined,
  hasToolCalls: boolean,
): string {
  switch (stopReason) {
    case "end_turn": return "stop";
    case "tool_use": return "tool_calls";
    case "max_tokens": return "length";
    case "model_context_window_exceeded": return "length";
    case "stop_sequence": return "stop";
    case "refusal": return "content_filter";
    default: return hasToolCalls ? "tool_calls" : "stop";
  }
}

// ---------------------------------------------------------------------------
// AnthropicStreamState + processAnthropicStreamEvent — reducer pattern
// ---------------------------------------------------------------------------

export interface AnthropicStreamState {
  chunkIndex: number;
  toolIndexMap: Map<string, number>;
  blockIndexToToolId: Map<number, string>;
  blockIndexToType: Map<number, string>;
  nextToolIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
  stopReason: string | undefined;
  receivedMessageStop: boolean;
}

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    chunkIndex: 0,
    toolIndexMap: new Map(),
    blockIndexToToolId: new Map(),
    blockIndexToType: new Map(),
    nextToolIndex: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
    stopReason: undefined,
    receivedMessageStop: false,
  };
}

export function processAnthropicStreamEvent(
  ev: Record<string, unknown>,
  state: AnthropicStreamState,
  model: string,
): ChatStreamChunk[] {
  const chunks: ChatStreamChunk[] = [];
  const chunkId = `chatcmpl-${state.chunkIndex++}`;

  if (ev.type === "message_start") {
    const msg = (ev.message as Record<string, unknown>) ?? {};
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage) {
      state.inputTokens = (usage.input_tokens as number) ?? 0;
      state.outputTokens = (usage.output_tokens as number) ?? 0;
      state.cacheReadTokens = (usage.cache_read_input_tokens as number) ?? 0;
      state.cacheCreationTokens = (usage.cache_creation_input_tokens as number) ?? 0;
      if (usage.thinking_tokens) state.thinkingTokens = usage.thinking_tokens as number;
    }
    return chunks;
  }

  if (ev.type === "message_delta") {
    const delta = ev.delta as Record<string, unknown> | undefined;
    if (delta?.stop_reason) {
      state.stopReason = delta.stop_reason as string;
    }
    const usage = ev.usage as Record<string, unknown> | undefined;
    if (usage?.output_tokens != null && (usage.output_tokens as number) > 0) {
      state.outputTokens = usage.output_tokens as number;
    }
    if (usage?.thinking_tokens != null && (usage.thinking_tokens as number) > 0) {
      state.thinkingTokens = usage.thinking_tokens as number;
    }
    return chunks;
  }

  if (ev.type === "content_block_start") {
    // Shallow-copy to guard against SDK mutating the original object
    const block = { ...((ev.content_block as Record<string, unknown>) ?? {}) };
    const blockIndex = ev.index as number | undefined;
    if (blockIndex !== undefined) {
      state.blockIndexToType.set(blockIndex, block.type as string);
    }

    if (block.type === "thinking") {
      chunks.push(makeChunk(chunkId, model, { thinking_content: "" }));
    } else if (block.type === "redacted_thinking") {
      const redactedData = block.data as string | undefined;
      chunks.push(makeChunk(chunkId, model, { redacted_thinking_data: redactedData ?? "" }));
    } else if (block.type === "text") {
      chunks.push(makeChunk(chunkId, model, { content: "" }));
    } else if (block.type === "tool_use") {
      const toolBlock = block as unknown as AnthropicToolUseBlock;
      if (!toolBlock.id || !toolBlock.name) return chunks;
      const idx = state.nextToolIndex++;
      state.toolIndexMap.set(toolBlock.id, idx);
      if (blockIndex !== undefined) {
        state.blockIndexToToolId.set(blockIndex, toolBlock.id);
      }
      chunks.push(makeChunk(chunkId, model, {
        tool_calls: [
          {
            index: idx,
            id: toolBlock.id,
            type: "function",
            function: { name: toolBlock.name, arguments: "" },
          },
        ],
      }));
    }
    return chunks;
  }

  if (ev.type === "content_block_delta") {
    if (!ev.delta) return chunks;
    const delta = ev.delta as Record<string, unknown>;
    const deltaType = delta.type;
    const blockIndex = ev.index as number | undefined;

    if (deltaType === "thinking_delta") {
      chunks.push(makeChunk(chunkId, model, {
        thinking_content: delta.thinking as string,
      }));
    } else if (deltaType === "text_delta") {
      chunks.push(makeChunk(chunkId, model, {
        content: delta.text as string,
      }));
    } else if (deltaType === "signature_delta") {
      if (blockIndex !== undefined && state.blockIndexToType.get(blockIndex) === "thinking") {
        chunks.push(makeChunk(chunkId, model, {
          thinking_signature: delta.signature as string,
        }));
      }
    } else if (deltaType === "input_json_delta") {
      const partialJson = (delta.partial_json as string) ?? "";
      if (!partialJson) return chunks;
      let toolId: string | undefined;
      if (blockIndex !== undefined) {
        toolId = state.blockIndexToToolId.get(blockIndex);
      }
      if (!toolId) {
        toolId = Array.from(state.toolIndexMap.keys()).pop();
      }
      if (toolId) {
        const idx = state.toolIndexMap.get(toolId)!;
        chunks.push(makeChunk(chunkId, model, {
          tool_calls: [
            {
              index: idx,
              function: { arguments: partialJson },
            },
          ],
        }));
      }
    }
    return chunks;
  }

  if (ev.type === "message_stop") {
    state.receivedMessageStop = true;
    const finishReason = mapAnthropicStopReason(state.stopReason, state.toolIndexMap.size > 0);
    chunks.push({
      id: chunkId,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: state.inputTokens,
        completion_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens,
        cache_read_tokens: state.cacheReadTokens || undefined,
        cache_creation_tokens: state.cacheCreationTokens || undefined,
        thinking_tokens: state.thinkingTokens || undefined,
      },
    });
    return chunks;
  }

  return chunks;
}

/**
 * Stream an Anthropic-compatible chat call and yield OpenAI-shaped ChatStreamChunks.
 * Works with Anthropic, AnthropicBedrock, and AnthropicVertex clients.
 */
export async function* streamAnthropicChat(
  client: AnthropicStreamClient,
  params: ChatParams,
  defaultModel: string,
  cacheConfig?: CacheControlConfig,
): AsyncIterable<ChatStreamChunk> {
  const { streamParams, model } = buildAnthropicRequestParams(params, defaultModel, cacheConfig);
  const requestSignal = params.signal;

  let stream: AsyncIterable<Record<string, unknown>>;
  try {
    stream = client.messages.stream(
      streamParams,
      requestSignal ? { signal: requestSignal } : undefined,
    );
  } catch (err: unknown) {
    const apiErr = err as { status?: number; headers?: Record<string, string> & { get?(k: string): string | null } };
    throw new ChatStreamError(
      err instanceof Error ? err.message : String(err),
      {
        status: apiErr.status,
        retryAfter: apiErr.headers?.get?.("retry-after") ?? apiErr.headers?.["retry-after"] ?? undefined,
        cause: err,
      },
    );
  }

  const state = createAnthropicStreamState();

  try {
    for await (const event of stream) {
      const ev = event as Record<string, unknown>;
      for (const chunk of processAnthropicStreamEvent(ev, state, model)) {
        yield chunk;
      }
    }

    if (!state.receivedMessageStop && state.chunkIndex > 0) {
      throw new ChatStreamError(
        "Stream ended without receiving message_stop event",
        { cause: new Error("incomplete_stream") },
      );
    } else if (state.chunkIndex === 0) {
      throw new ChatStreamError(
        "Stream returned no events",
        { cause: new Error("empty_stream") },
      );
    }
  } catch (err: unknown) {
    if (err instanceof ChatStreamError) throw err;
    const apiErr = err as { status?: number; headers?: Record<string, string> & { get?(k: string): string | null } };
    throw new ChatStreamError(
      err instanceof Error ? err.message : String(err),
      {
        status: apiErr.status,
        retryAfter: apiErr.headers?.get?.("retry-after") ?? apiErr.headers?.["retry-after"] ?? undefined,
        cause: err,
      },
    );
  }
}
