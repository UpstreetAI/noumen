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
    stream(params: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
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
        const lastBlock = content[content.length - 1] as Record<string, unknown>;
        lastBlock.cache_control = buildCacheControlBlock(cacheConfig);
      }
      result.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      const isMultipart = Array.isArray(msg.content);
      const toolContent = isMultipart
        ? contentPartsToAnthropic(msg.content as ContentPart[])
        : (msg.content as string);

      const toolResultBlock: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: toolContent,
      };
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
        schema: params.outputFormat.schema,
      },
    };
    const betas: string[] = (streamParams.betas as string[] | undefined) ?? [];
    if (!betas.includes("structured-outputs-2025-12-15")) {
      betas.push("structured-outputs-2025-12-15");
    }
    streamParams.betas = betas;
  } else if (params.outputFormat?.type === "json_object") {
    // Anthropic has no native json_object mode. Prepend a system-level hint
    // so the model knows to produce valid JSON.
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

  let stream: AsyncIterable<Record<string, unknown>>;
  try {
    stream = client.messages.stream(streamParams);
  } catch (err: unknown) {
    const apiErr = err as { status?: number; headers?: { get?(k: string): string | null } };
    throw new ChatStreamError(
      err instanceof Error ? err.message : String(err),
      {
        status: apiErr.status,
        retryAfter: apiErr.headers?.get?.("retry-after") ?? undefined,
        cause: err,
      },
    );
  }

  let chunkIndex = 0;
  const toolIndexMap = new Map<string, number>();
  const blockIndexToToolId = new Map<number, string>();
  const blockIndexToType = new Map<number, string>();
  let nextToolIndex = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let thinkingTokens = 0;
  let stopReason: string | undefined;
  let receivedMessageStop = false;

  try {
  for await (const event of stream) {
    const ev = event as Record<string, unknown>;
    const chunkId = `chatcmpl-${chunkIndex++}`;

    if (ev.type === "message_start") {
      const msg = (ev.message as Record<string, unknown>) ?? {};
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage) {
        inputTokens = (usage.input_tokens as number) ?? 0;
        outputTokens = (usage.output_tokens as number) ?? 0;
        cacheReadTokens = (usage.cache_read_input_tokens as number) ?? 0;
        cacheCreationTokens = (usage.cache_creation_input_tokens as number) ?? 0;
        if (usage.thinking_tokens) thinkingTokens = usage.thinking_tokens as number;
      }
      continue;
    }

    if (ev.type === "message_delta") {
      const delta = (ev as Record<string, unknown>).delta as Record<string, unknown> | undefined;
      if (delta?.stop_reason) {
        stopReason = delta.stop_reason as string;
      }
      const usage = (ev as Record<string, unknown>).usage as
        | Record<string, unknown>
        | undefined;
      if (usage?.output_tokens) {
        outputTokens = usage.output_tokens as number;
      }
      if (usage?.thinking_tokens) {
        thinkingTokens = usage.thinking_tokens as number;
      }
      continue;
    }

    if (ev.type === "content_block_start") {
      const block = (ev.content_block as Record<string, unknown>) ?? {};
      const blockIndex = ev.index as number | undefined;
      if (blockIndex !== undefined) {
        blockIndexToType.set(blockIndex, block.type as string);
      }

      if (block.type === "thinking") {
        yield makeChunk(chunkId, model, { thinking_content: "" });
      } else if (block.type === "redacted_thinking") {
        yield makeChunk(chunkId, model, { thinking_content: "" });
      } else if (block.type === "text") {
        yield makeChunk(chunkId, model, { content: "" });
      } else if (block.type === "tool_use") {
        const toolBlock = block as unknown as AnthropicToolUseBlock;
        const idx = nextToolIndex++;
        toolIndexMap.set(toolBlock.id, idx);
        if (blockIndex !== undefined) {
          blockIndexToToolId.set(blockIndex, toolBlock.id);
        }
        yield makeChunk(chunkId, model, {
          tool_calls: [
            {
              index: idx,
              id: toolBlock.id,
              type: "function",
              function: { name: toolBlock.name, arguments: "" },
            },
          ],
        });
      }
    } else if (ev.type === "content_block_delta") {
      const delta = ev.delta as Record<string, unknown>;
      const deltaType = delta.type;
      const blockIndex = ev.index as number | undefined;

      if (deltaType === "thinking_delta") {
        yield makeChunk(chunkId, model, {
          thinking_content: delta.thinking as string,
        });
      } else if (deltaType === "text_delta") {
        yield makeChunk(chunkId, model, {
          content: delta.text as string,
        });
      } else if (deltaType === "signature_delta") {
        if (blockIndex !== undefined && blockIndexToType.get(blockIndex) === "thinking") {
          yield makeChunk(chunkId, model, {
            thinking_signature: delta.signature as string,
          });
        }
      } else if (deltaType === "input_json_delta") {
        let toolId: string | undefined;
        if (blockIndex !== undefined) {
          toolId = blockIndexToToolId.get(blockIndex);
        }
        if (!toolId) {
          toolId = Array.from(toolIndexMap.keys()).pop();
        }
        if (toolId) {
          const idx = toolIndexMap.get(toolId)!;
          yield makeChunk(chunkId, model, {
            tool_calls: [
              {
                index: idx,
                function: { arguments: delta.partial_json as string },
              },
            ],
          });
        }
      }
    } else if (ev.type === "message_stop") {
      receivedMessageStop = true;
      let finishReason: string;
      switch (stopReason) {
        case "end_turn": finishReason = "stop"; break;
        case "tool_use": finishReason = "tool_calls"; break;
        case "max_tokens": finishReason = "length"; break;
        case "model_context_window_exceeded": finishReason = "length"; break;
        case "stop_sequence": finishReason = "stop"; break;
        case "refusal": finishReason = "content_filter"; break;
        default: finishReason = toolIndexMap.size > 0 ? "tool_calls" : "stop"; break;
      }
      yield {
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
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cache_read_tokens: cacheReadTokens || undefined,
          cache_creation_tokens: cacheCreationTokens || undefined,
          thinking_tokens: thinkingTokens || undefined,
        },
      };
    }
  }

  if (!receivedMessageStop && chunkIndex <= 1) {
    throw new ChatStreamError(
      "Stream ended without receiving message_stop event",
      { cause: new Error("incomplete_stream") },
    );
  }
  } catch (err: unknown) {
    if (err instanceof ChatStreamError) throw err;
    const apiErr = err as { status?: number; headers?: { get?(k: string): string | null } };
    throw new ChatStreamError(
      err instanceof Error ? err.message : String(err),
      {
        status: apiErr.status,
        retryAfter: apiErr.headers?.get?.("retry-after") ?? undefined,
        cause: err,
      },
    );
  }
}
