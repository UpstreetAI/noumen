import { GoogleGenAI } from "@google/genai";
import type {
  AIProvider,
  ChatParams,
  ChatStreamChunk,
} from "./types.js";
import { ChatStreamError } from "./types.js";
import type { ChatMessage, ContentPart } from "../session/types.js";

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
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
    const clientOpts: Record<string, unknown> = { apiKey: opts.apiKey };
    if (opts.baseURL) clientOpts.httpOptions = { baseUrl: opts.baseURL };
    this.client = new GoogleGenAI(clientOpts as ConstructorParameters<typeof GoogleGenAI>[0]);
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
    };

    if (thinkingEnabled) {
      config.thinkingConfig = { thinkingBudget: thinkingBudget };
    }

    if (params.outputFormat?.type === "json_schema") {
      config.responseSchema = params.outputFormat.schema;
      config.responseMimeType = "application/json";
    } else if (params.outputFormat?.type === "json_object") {
      config.responseMimeType = "application/json";
    }

    if (params.signal) {
      (config as Record<string, unknown>).httpOptions = {
        ...((config as Record<string, unknown>).httpOptions as Record<string, unknown> ?? {}),
        signal: params.signal,
      };
    }

    try {
    const stream = await this.client.models.generateContentStream({
      model: params.model ?? this.defaultModel,
      contents,
      config,
    });

    let chunkIndex = 0;
    let toolCallIndex = 0;
    let responseHasToolCalls = false;
    let finishReasonSeen = false;
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

      if (parts) {
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
            responseHasToolCalls = true;

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
      }

      const finishReason = candidates[0].finishReason;
      if (finishReason && finishReason !== "FINISH_REASON_UNSPECIFIED") {
        let mapped: string;
        if (finishReason === "STOP") {
          mapped = responseHasToolCalls ? "tool_calls" : "stop";
        } else if (finishReason === "MAX_TOKENS") {
          mapped = "length";
        } else if (finishReason === "SAFETY" || finishReason === "RECITATION") {
          mapped = "content_filter";
        } else {
          mapped = "stop";
        }

        finishReasonSeen = true;
        yield {
          id: chunkId,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: mapped }],
          usage: lastUsage,
        };
      }
    }

    if (!finishReasonSeen && chunkIndex > 0) {
      throw new ChatStreamError("Gemini stream ended without finish reason", {
        cause: new Error("incomplete_stream"),
      });
    }
    } catch (err: unknown) {
      if (err instanceof ChatStreamError) throw err;
      const apiErr = err as { status?: number; statusCode?: number; code?: number };
      const status = apiErr.status ?? apiErr.statusCode ?? apiErr.code;
      throw new ChatStreamError(
        err instanceof Error ? err.message : String(err),
        {
          status: typeof status === "number" ? status : undefined,
          cause: err,
        },
      );
    }
  }

  private static contentPartsToGemini(parts: ContentPart[]): GeminiPart[] {
    return parts.map((part) => {
      if (part.type === "text") {
        return { text: part.text };
      }
      if (part.type === "image") {
        return { inlineData: { mimeType: part.media_type, data: part.data } };
      }
      // image_url — Gemini doesn't natively support URL references as inlineData;
      // pass it as text with the URL. Consumers should prefer base64 ImageContent.
      return { text: `[image: ${part.url}]` };
    });
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
        if (Array.isArray(msg.content)) {
          const parts = GeminiProvider.contentPartsToGemini(msg.content as ContentPart[]);
          contents.push({ role: "user", parts });
        } else {
          contents.push({ role: "user", parts: [{ text: msg.content as string }] });
        }
      } else if (msg.role === "assistant") {
        const parts: GeminiPart[] = [];
        if (msg.thinking_content) {
          parts.push({ text: msg.thinking_content, thought: true });
        }
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
        if (parts.length === 0) {
          parts.push({ text: "" });
        }
        contents.push({ role: "model", parts });
      } else if (msg.role === "tool") {
        const fnName =
          toolCallIdToName.get(msg.tool_call_id) ?? msg.tool_call_id;
        const resultValue = Array.isArray(msg.content)
          ? (msg.content as ContentPart[])
              .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
              .map((p) => p.text)
              .join("")
          : msg.content;
        pendingFunctionResponses.push({
          functionResponse: {
            name: fnName,
            response: { result: resultValue },
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
