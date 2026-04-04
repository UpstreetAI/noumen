import Anthropic from "@anthropic-ai/sdk";
import type {
  AIProvider,
  ChatParams,
  ChatStreamChunk,
} from "./types.js";
import type { ChatMessage, ContentPart } from "../session/types.js";
import type { CacheControlConfig } from "./cache.js";
import { getMessageCacheBreakpointIndex } from "./cache.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** When enabled, injects cache_control markers on system prompt, tools, and messages. */
  cacheControl?: CacheControlConfig;
}

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

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private defaultModel: string;
  private cacheConfig: CacheControlConfig | undefined;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });
    this.defaultModel = opts.model ?? "claude-sonnet-4-20250514";
    this.cacheConfig = opts.cacheControl;
  }

  private buildCacheControl(): CacheControlBlock {
    const cc: CacheControlBlock = { type: "ephemeral" };
    if (this.cacheConfig?.ttl) cc.ttl = this.cacheConfig.ttl;
    if (this.cacheConfig?.scope) cc.scope = this.cacheConfig.scope;
    return cc;
  }

  private get cachingEnabled(): boolean {
    return this.cacheConfig?.enabled === true;
  }

  async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    const { system, messages: inputMessages } = this.convertMessages(
      params.system,
      params.messages,
      params.skipCacheWrite,
    );

    const tools = this.buildTools(params);

    const thinkingEnabled =
      params.thinking?.type === "enabled" &&
      (params.thinking as { budgetTokens: number }).budgetTokens > 0;
    const budgetTokens = thinkingEnabled
      ? (params.thinking as { type: "enabled"; budgetTokens: number }).budgetTokens
      : 0;

    const maxOutputTokens = thinkingEnabled
      ? budgetTokens + (params.max_tokens ?? 8192)
      : (params.max_tokens ?? 8192);

    const streamParams: Anthropic.Messages.MessageStreamParams = {
      model: params.model ?? this.defaultModel,
      max_tokens: maxOutputTokens,
      system,
      messages: inputMessages,
      tools,
    };

    if (thinkingEnabled) {
      (streamParams as unknown as Record<string, unknown>).thinking = {
        type: "enabled",
        budget_tokens: budgetTokens,
      };
    }

    if (params.outputFormat?.type === "json_schema") {
      const extra = streamParams as unknown as Record<string, unknown>;
      extra.output_config = {
        format: {
          type: "json_schema",
          schema: params.outputFormat.schema,
        },
      };
      const betas: string[] =
        (extra.betas as string[] | undefined) ?? [];
      if (!betas.includes("structured-outputs-2025-12-15")) {
        betas.push("structured-outputs-2025-12-15");
      }
      extra.betas = betas;
    }

    const stream = this.client.messages.stream(streamParams);

    let chunkIndex = 0;
    const toolIndexMap = new Map<string, number>();
    let nextToolIndex = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    for await (const event of stream) {
      const chunkId = `chatcmpl-${chunkIndex++}`;

      if (event.type === "message_start") {
        const msg = event.message;
        if (msg.usage) {
          inputTokens = msg.usage.input_tokens ?? 0;
          outputTokens = msg.usage.output_tokens ?? 0;
          const u = msg.usage as unknown as Record<string, unknown>;
          cacheReadTokens = (u.cache_read_input_tokens as number) ?? 0;
          cacheCreationTokens = (u.cache_creation_input_tokens as number) ?? 0;
        }
        continue;
      }

      if (event.type === "message_delta") {
        const delta = event as { type: string; usage?: { output_tokens?: number } };
        if (delta.usage?.output_tokens) {
          outputTokens = delta.usage.output_tokens;
        }
        continue;
      }

      if (event.type === "content_block_start") {
        const block = event.content_block as unknown as { type: string; [key: string]: unknown };

        if (block.type === "thinking") {
          yield this.makeChunk(chunkId, params.model ?? this.defaultModel, {
            thinking_content: "",
          });
        } else if (block.type === "text") {
          yield this.makeChunk(chunkId, params.model ?? this.defaultModel, {
            content: "",
          });
        } else if (block.type === "tool_use") {
          const toolBlock = block as unknown as AnthropicToolUseBlock;
          const idx = nextToolIndex++;
          toolIndexMap.set(toolBlock.id, idx);
          yield this.makeChunk(chunkId, params.model ?? this.defaultModel, {
            tool_calls: [
              {
                index: idx,
                id: toolBlock.id,
                type: "function" as const,
                function: { name: toolBlock.name, arguments: "" },
              },
            ],
          });
        }
      } else if (event.type === "content_block_delta") {
        const deltaType = event.delta.type;

        if (deltaType === "thinking_delta") {
          const thinkingDelta = event.delta as { type: string; thinking: string };
          yield this.makeChunk(chunkId, params.model ?? this.defaultModel, {
            thinking_content: thinkingDelta.thinking,
          });
        } else if (deltaType === "text_delta") {
          yield this.makeChunk(chunkId, params.model ?? this.defaultModel, {
            content: event.delta.text,
          });
        } else if (deltaType === "input_json_delta") {
          const delta = event.delta as { type: string; partial_json: string };
          const lastToolId = Array.from(toolIndexMap.keys()).pop()!;
          const idx = toolIndexMap.get(lastToolId)!;
          yield this.makeChunk(chunkId, params.model ?? this.defaultModel, {
            tool_calls: [
              {
                index: idx,
                function: { arguments: delta.partial_json },
              },
            ],
          });
        }
      } else if (event.type === "message_stop") {
        yield {
          id: chunkId,
          model: params.model ?? this.defaultModel,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: toolIndexMap.size > 0 ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            cache_read_tokens: cacheReadTokens || undefined,
            cache_creation_tokens: cacheCreationTokens || undefined,
          },
        };
      }
    }
  }

  private buildTools(
    params: ChatParams,
  ): Anthropic.Messages.Tool[] | undefined {
    if (!params.tools) return undefined;

    const tools = params.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Anthropic.Messages.Tool["input_schema"],
    }));

    if (this.cachingEnabled && tools.length > 0) {
      const lastTool = tools[tools.length - 1] as Record<string, unknown>;
      lastTool.cache_control = this.buildCacheControl();
    }

    return tools;
  }

  private makeChunk(
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
   * Build the system prompt for the API call, optionally with cache_control.
   */
  private buildSystemBlocks(
    systemPrompt: string | undefined,
  ): Anthropic.Messages.TextBlockParam[] | string | undefined {
    if (!systemPrompt) return undefined;

    if (!this.cachingEnabled) return systemPrompt;

    const block = {
      type: "text" as const,
      text: systemPrompt,
      cache_control: this.buildCacheControl(),
    };
    return [block as unknown as Anthropic.Messages.TextBlockParam];
  }

  private contentPartsToAnthropic(
    parts: ContentPart[],
  ): Anthropic.Messages.ContentBlockParam[] {
    return parts.map((part) => {
      if (part.type === "text") {
        return { type: "text" as const, text: part.text };
      }
      if (part.type === "image") {
        return {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: part.media_type as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: part.data,
          },
        };
      }
      // image_url
      return {
        type: "image" as const,
        source: { type: "url" as const, url: part.url },
      };
    }) as Anthropic.Messages.ContentBlockParam[];
  }

  private convertMessages(
    systemPrompt: string | undefined,
    messages: ChatMessage[],
    skipCacheWrite?: boolean,
  ): {
    system: Anthropic.Messages.TextBlockParam[] | string | undefined;
    messages: Anthropic.Messages.MessageParam[];
  } {
    const result: Anthropic.Messages.MessageParam[] = [];

    const cacheBreakpointIdx = this.cachingEnabled
      ? getMessageCacheBreakpointIndex(messages, skipCacheWrite)
      : -1;

    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      const addCache = mi === cacheBreakpointIdx;

      if (msg.role === "system") {
        continue;
      }

      if (msg.role === "user") {
        const isMultipart = Array.isArray(msg.content);
        if (addCache && this.cachingEnabled) {
          const blocks = isMultipart
            ? this.contentPartsToAnthropic(msg.content as ContentPart[])
            : [{ type: "text" as const, text: msg.content as string }];
          const lastBlock = blocks[blocks.length - 1] as unknown as Record<string, unknown>;
          lastBlock.cache_control = this.buildCacheControl();
          result.push({
            role: "user",
            content: blocks as Anthropic.Messages.ContentBlockParam[],
          });
        } else if (isMultipart) {
          result.push({
            role: "user",
            content: this.contentPartsToAnthropic(msg.content as ContentPart[]),
          });
        } else {
          result.push({ role: "user", content: msg.content as string });
        }
      } else if (msg.role === "assistant") {
        const content: Anthropic.Messages.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            });
          }
        }

        if (addCache && this.cachingEnabled && content.length > 0) {
          const lastBlock = content[content.length - 1] as unknown as Record<string, unknown>;
          lastBlock.cache_control = this.buildCacheControl();
        }

        result.push({ role: "assistant", content });
      } else if (msg.role === "tool") {
        const isMultipart = Array.isArray(msg.content);
        const toolContent = isMultipart
          ? this.contentPartsToAnthropic(msg.content as ContentPart[])
          : (msg.content as string);

        const toolResultBlock = {
          type: "tool_result" as const,
          tool_use_id: msg.tool_call_id,
          content: toolContent,
          ...(addCache && this.cachingEnabled
            ? { cache_control: this.buildCacheControl() }
            : {}),
        };

        result.push({
          role: "user",
          content: [toolResultBlock as unknown as Anthropic.Messages.ToolResultBlockParam],
        });
      }
    }

    return { system: this.buildSystemBlocks(systemPrompt), messages: result };
  }
}
