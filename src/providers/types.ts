import type { ChatMessage } from "../session/types.js";
import type { ThinkingConfig } from "../thinking/types.js";

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameterProperty>;
      required?: string[];
    };
  };
}

// Streaming chunk types (OpenAI-compatible)

export interface ChatStreamDelta {
  role?: "assistant";
  content?: string | null;
  thinking_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface ChatStreamChoice {
  index: number;
  delta: ChatStreamDelta;
  finish_reason: string | null;
}

export interface ChatStreamChunk {
  id: string;
  choices: ChatStreamChoice[];
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    thinking_tokens?: number;
  };
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  thinking_tokens?: number;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  system?: string;
  temperature?: number;
  thinking?: ThinkingConfig;
}

export interface AIProvider {
  chat(params: ChatParams): AsyncIterable<ChatStreamChunk>;
}

/**
 * Extended error type that providers can throw to convey retry-relevant metadata.
 * Consumers (like the retry engine) can inspect these fields without knowing
 * provider-specific SDK error types.
 */
export class ChatStreamError extends Error {
  status?: number;
  retryAfter?: string;

  constructor(
    message: string,
    opts?: { status?: number; retryAfter?: string; cause?: unknown },
  ) {
    super(message, { cause: opts?.cause });
    this.name = "ChatStreamError";
    this.status = opts?.status;
    this.retryAfter = opts?.retryAfter;
  }
}
