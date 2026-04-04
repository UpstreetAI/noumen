import type { UUID } from "../utils/uuid.js";
import type { ChatCompletionUsage } from "../providers/types.js";
import type { CostSummary } from "../cost/types.js";
import type { MemoryEntry } from "../memory/types.js";

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

export interface ToolResultOverflowEntry {
  type: "tool-result-overflow";
  sessionId: string;
  timestamp: string;
  toolCallId: string;
  originalContent: string;
}

export type Entry =
  | MessageEntry
  | CompactBoundaryEntry
  | SummaryEntry
  | CustomTitleEntry
  | MetadataEntry
  | ToolResultOverflowEntry;

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
  | { type: "microcompact_complete"; tokensFreed: number }
  | {
      type: "tool_result_truncated";
      toolCallId: string;
      originalChars: number;
      truncatedChars: number;
    }
  | { type: "error"; error: Error }
  | {
      type: "permission_request";
      toolName: string;
      input: Record<string, unknown>;
      message: string;
    }
  | {
      type: "permission_granted";
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: "permission_denied";
      toolName: string;
      input: Record<string, unknown>;
      message: string;
    }
  | { type: "thinking_delta"; text: string }
  | { type: "cost_update"; summary: CostSummary }
  | {
      type: "retry_attempt";
      attempt: number;
      maxRetries: number;
      delayMs: number;
      error: Error;
    }
  | { type: "retry_exhausted"; attempts: number; error: Error }
  | { type: "subagent_start"; toolUseId: string; prompt: string }
  | { type: "subagent_end"; toolUseId: string; result: string }
  | {
      type: "user_input_request";
      toolUseId: string;
      question: string;
    }
  | {
      type: "denial_limit_exceeded";
      consecutiveDenials: number;
      totalDenials: number;
    }
  | { type: "span_start"; name: string; spanId: string }
  | {
      type: "span_end";
      name: string;
      spanId: string;
      durationMs: number;
      error?: string;
    }
  | {
      type: "memory_update";
      created: MemoryEntry[];
      updated: MemoryEntry[];
      deleted: string[];
    };

export interface RunOptions {
  signal?: AbortSignal;
}
