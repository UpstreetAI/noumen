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
}

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private defaultModel: string;

  constructor(opts: OpenAIProviderOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });
    this.defaultModel = opts.model ?? "gpt-4o";
  }

  async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    const messages = this.buildMessages(params.system, params.messages);

    const stream = await this.client.chat.completions.create({
      model: params.model ?? this.defaultModel,
      messages: messages as unknown as OpenAI.ChatCompletionMessageParam[],
      tools: params.tools?.map((t) => ({
        type: "function" as const,
        function: t.function,
      })),
      max_tokens: params.max_tokens,
      temperature: params.temperature,
      stream: true,
    });

    for await (const chunk of stream) {
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
        usage: chunk.usage
          ? {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
            }
          : undefined,
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
