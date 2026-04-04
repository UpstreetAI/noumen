import OpenAI from "openai";
import type {
  AIProvider,
  ChatParams,
  ChatStreamChunk,
} from "./types.js";
import type { ChatMessage } from "../session/types.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  defaultHeaders?: Record<string, string | undefined>;
}

const O_SERIES_PATTERN = /^o[1-9]/;

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private defaultModel: string;

  constructor(opts: OpenAIProviderOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      defaultHeaders: opts.defaultHeaders,
    });
    this.defaultModel = opts.model ?? "gpt-4o";
  }

  async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    const messages = this.buildMessages(params.system, params.messages);
    const model = params.model ?? this.defaultModel;
    const isOSeries = O_SERIES_PATTERN.test(model);

    const createParams: OpenAI.ChatCompletionCreateParamsStreaming = {
      model,
      messages: messages as unknown as OpenAI.ChatCompletionMessageParam[],
      tools: params.tools?.map((t) => ({
        type: "function" as const,
        function: t.function,
      })),
      stream: true,
    };

    if (isOSeries && params.thinking?.type === "enabled") {
      (createParams as unknown as Record<string, unknown>).reasoning_effort = "high";
    } else {
      createParams.max_tokens = params.max_tokens;
      createParams.temperature = params.temperature;
    }

    if (params.outputFormat?.type === "json_schema") {
      (createParams as unknown as Record<string, unknown>).response_format = {
        type: "json_schema",
        json_schema: {
          name: params.outputFormat.name ?? "response",
          schema: params.outputFormat.schema,
          strict: params.outputFormat.strict ?? false,
        },
      };
    }

    const stream = await this.client.chat.completions.create(createParams);

    for await (const chunk of stream) {
      const usage = chunk.usage;
      let mappedUsage: ChatStreamChunk["usage"] | undefined;
      if (usage) {
        const u = usage as unknown as Record<string, unknown>;
        const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined;
        const completionDetails = u.completion_tokens_details as Record<string, unknown> | undefined;
        mappedUsage = {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          cache_read_tokens: promptDetails?.cached_tokens as number | undefined,
          thinking_tokens: completionDetails?.reasoning_tokens as number | undefined,
        };
      }

      yield {
        id: chunk.id,
        model: chunk.model,
        choices: chunk.choices.map((c) => ({
          index: c.index,
          delta: {
            role: c.delta.role as "assistant" | undefined,
            content: c.delta.content,
            tool_calls: c.delta.tool_calls?.map((tc) => ({
              index: tc.index,
              id: tc.id,
              type: tc.type as "function" | undefined,
              function: tc.function
                ? {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  }
                : undefined,
            })),
          },
          finish_reason: c.finish_reason,
        })),
        usage: mappedUsage,
      };
    }
  }

  private buildMessages(
    system: string | undefined,
    messages: ChatMessage[],
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    if (system) {
      result.push({ role: "system", content: system });
    }
    for (const msg of messages) {
      if (msg.role === "tool") {
        result.push({
          role: "tool",
          tool_call_id: msg.tool_call_id,
          content: msg.content,
        });
      } else if (msg.role === "assistant") {
        const entry: Record<string, unknown> = {
          role: "assistant",
          content: msg.content,
        };
        if (msg.tool_calls) {
          entry.tool_calls = msg.tool_calls;
        }
        result.push(entry);
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
    }
    return result;
  }
}
