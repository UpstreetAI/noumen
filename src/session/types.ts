import type { UUID } from "../utils/uuid.js";
import type { ChatCompletionUsage } from "../providers/types.js";

// --- Chat message types (OpenAI-compatible format) ---

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCallContent {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCallContent[];
}

export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | SystemMessage;

// --- Session / persistence types ---

export interface SerializedMessage {
  uuid: UUID;
  parentUuid: UUID | null;
  sessionId: string;
  timestamp: string;
  message: ChatMessage;
}

export type EntryType =
  | "message"
  | "compact-boundary"
  | "summary"
  | "custom-title"
  | "metadata";

export interface MessageEntry {
  type: "message";
  uuid: UUID;
  parentUuid: UUID | null;
  sessionId: string;
  timestamp: string;
  message: ChatMessage;
}

export interface CompactBoundaryEntry {
  type: "compact-boundary";
  uuid: UUID;
  sessionId: string;
  timestamp: string;
}

export interface SummaryEntry {
  type: "summary";
  uuid: UUID;
  parentUuid: UUID | null;
  sessionId: string;
  timestamp: string;
  message: ChatMessage;
}

export interface CustomTitleEntry {
  type: "custom-title";
  sessionId: string;
  title: string;
  timestamp: string;
}

export interface MetadataEntry {
  type: "metadata";
  sessionId: string;
  timestamp: string;
  key: string;
  value: unknown;
}

export type Entry =
  | MessageEntry
  | CompactBoundaryEntry
  | SummaryEntry
  | CustomTitleEntry
  | MetadataEntry;

export interface SessionInfo {
  sessionId: string;
  createdAt: string;
  lastMessageAt: string;
  title?: string;
  messageCount: number;
}

// --- Stream event types ---

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; toolName: string; toolUseId: string }
  | { type: "tool_use_delta"; input: string }
  | {
      type: "tool_result";
      toolUseId: string;
      toolName: string;
      result: ToolResult;
    }
  | { type: "message_complete"; message: AssistantMessage }
  | { type: "usage"; usage: ChatCompletionUsage; model: string }
  | {
      type: "turn_complete";
      usage: ChatCompletionUsage;
      model: string;
      callCount: number;
    }
  | { type: "compact_start" }
  | { type: "compact_complete" }
  | { type: "error"; error: Error };

export interface RunOptions {
  signal?: AbortSignal;
}
