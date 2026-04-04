import { GoogleGenAI } from "@google/genai";
import type {
  AIProvider,
  ChatParams,
  ChatStreamChunk,
} from "./types.js";
import type { ChatMessage } from "../session/types.js";

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: {
    name: string;
    response: { result: unknown };
  };
}

export class GeminiProvider implements AIProvider {
  private client: GoogleGenAI;
  private defaultModel: string;

  constructor(opts: GeminiProviderOptions) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
    this.defaultModel = opts.model ?? "gemini-2.5-flash";
  }

  async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    const { contents, systemInstruction } = this.convertMessages(
      params.system,
      params.messages,
    );

    const tools = params.tools?.length
      ? [
          {
            functionDeclarations: params.tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters as Record<string, unknown>,
            })),
          },
        ]
      : undefined;

    const thinkingEnabled =
      params.thinking?.type === "enabled" &&
      (params.thinking as { budgetTokens: number }).budgetTokens > 0;
    const thinkingBudget = thinkingEnabled
      ? (params.thinking as { type: "enabled"; budgetTokens: number }).budgetTokens
      : 0;

    const config: Record<string, unknown> = {
      systemInstruction: systemInstruction || undefined,
      maxOutputTokens: params.max_tokens,
      temperature: params.temperature,
      tools,
      thinkingConfig: {
        thinkingBudget: thinkingBudget,
      },
    };

    if (params.outputFormat?.type === "json_schema") {
      config.responseSchema = params.outputFormat.schema;
      config.responseMimeType = "application/json";
    }

    const stream = await this.client.models.generateContentStream({
      model: params.model ?? this.defaultModel,
      contents,
      config,
    });

    let chunkIndex = 0;
    let toolCallIndex = 0;
    let lastUsage: ChatStreamChunk["usage"] | undefined;

    for await (const chunk of stream) {
      const chunkId = `gemini-${chunkIndex++}`;
      const model = params.model ?? this.defaultModel;

      const meta = chunk.usageMetadata as
        | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; thoughtsTokenCount?: number }
        | undefined;
      if (meta) {
        const prompt = meta.promptTokenCount ?? 0;
        const completion = meta.candidatesTokenCount ?? 0;
        lastUsage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: meta.totalTokenCount ?? (prompt + completion),
          thinking_tokens: meta.thoughtsTokenCount || undefined,
        };
      }

      const candidates = chunk.candidates;
      if (!candidates || candidates.length === 0) continue;

      const parts = candidates[0].content?.parts as GeminiPart[] | undefined;
      if (!parts) continue;

      for (const part of parts) {
        if (part.thought && part.text !== undefined && part.text !== null) {
          yield {
            id: chunkId,
            model,
            choices: [
              {
                index: 0,
                delta: { thinking_content: part.text },
                finish_reason: null,
              },
            ],
          };
          continue;
        }

        if (part.text !== undefined && part.text !== null) {
          yield {
            id: chunkId,
            model,
            choices: [
              {
                index: 0,
                delta: { content: part.text },
                finish_reason: null,
              },
            ],
          };
        }

        if (part.functionCall) {
          const fc = part.functionCall;
          const tcId = `gemini-tc-${toolCallIndex}`;
          const idx = toolCallIndex++;

          yield {
            id: chunkId,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: idx,
                      id: tcId,
                      type: "function" as const,
                      function: {
                        name: fc.name,
                        arguments: JSON.stringify(fc.args ?? {}),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
        }
      }

      const finishReason = candidates[0].finishReason;
      if (finishReason && finishReason !== "FINISH_REASON_UNSPECIFIED") {
        const mapped =
          finishReason === "STOP"
            ? toolCallIndex > 0
              ? "tool_calls"
              : "stop"
            : "stop";

        yield {
          id: chunkId,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: mapped }],
          usage: lastUsage,
        };
      }
    }
  }

  private convertMessages(
    systemPrompt: string | undefined,
    messages: ChatMessage[],
  ): { contents: GeminiContent[]; systemInstruction: string | undefined } {
    const contents: GeminiContent[] = [];

    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallIdToName.set(tc.id, tc.function.name);
        }
      }
    }

    let pendingFunctionResponses: GeminiPart[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        continue;
      }

      if (msg.role === "user") {
        if (pendingFunctionResponses.length > 0) {
          contents.push({ role: "user", parts: pendingFunctionResponses });
          pendingFunctionResponses = [];
        }
        contents.push({ role: "user", parts: [{ text: msg.content }] });
      } else if (msg.role === "assistant") {
        const parts: GeminiPart[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              // malformed
            }
            parts.push({
              functionCall: { name: tc.function.name, args },
            });
          }
        }
        if (parts.length > 0) {
          contents.push({ role: "model", parts });
        }
      } else if (msg.role === "tool") {
        const fnName =
          toolCallIdToName.get(msg.tool_call_id) ?? msg.tool_call_id;
        pendingFunctionResponses.push({
          functionResponse: {
            name: fnName,
            response: { result: msg.content },
          },
        });
      }
    }

    if (pendingFunctionResponses.length > 0) {
      contents.push({ role: "user", parts: pendingFunctionResponses });
    }

    return { contents, systemInstruction: systemPrompt };
  }
}
