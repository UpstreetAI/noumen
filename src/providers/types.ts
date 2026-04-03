import type { ChatMessage } from "../session/types.js";

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
  };
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  system?: string;
  temperature?: number;
}

export interface AIProvider {
  chat(params: ChatParams): AsyncIterable<ChatStreamChunk>;
}
