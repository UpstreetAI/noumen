import type { UUID } from "../utils/uuid.js";
import type { ChatCompletionUsage, OutputFormat } from "../providers/types.js";
import type { CostSummary } from "../cost/types.js";
import type { MemoryEntry } from "../memory/types.js";
import type { FileCheckpointSnapshot } from "../checkpoint/types.js";

// --- Chat message types (OpenAI-compatible format) ---

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  /** base64-encoded image data */
  data: string;
  /** MIME type: "image/png", "image/jpeg", "image/gif", "image/webp" */
  media_type: string;
}

export interface ImageUrlContent {
  type: "image_url";
  /** URL pointing to an image */
  url: string;
}

export type ContentPart = TextContent | ImageContent | ImageUrlContent;

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
  content: string | ContentPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCallContent[];
  /** Accumulated thinking content for providers that support extended thinking (e.g. Anthropic). */
  thinking_content?: string;
  /** Thinking signature required by Anthropic to verify thinking blocks across turns. */
  thinking_signature?: string;
  /** Opaque data for Anthropic redacted_thinking blocks — must be echoed back verbatim. */
  redacted_thinking_data?: string;
  /**
   * Internal turn identifier linking assistant chunks from the same provider
   * response. Used by normalization to merge non-adjacent assistant messages
   * that belong to the same logical turn (separated by tool result rows).
   * Stripped before sending to providers.
   */
  _turnId?: string;
}

export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string | ContentPart[];
  /** When true, signals to the provider that this tool result is an error. */
  isError?: boolean;
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
  | "metadata"
  | "file-checkpoint"
  | "tool-result-overflow"
  | "content-replacement"
  | "snip-boundary";

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

export interface FileCheckpointEntry {
  type: "file-checkpoint";
  sessionId: string;
  timestamp: string;
  messageId: string;
  snapshot: FileCheckpointSnapshot;
  isSnapshotUpdate: boolean;
}

export interface SnipBoundaryEntry {
  type: "snip-boundary";
  sessionId: string;
  timestamp: string;
  snipMetadata: {
    removedUuids: string[];
  };
}

export interface ContentReplacementRecord {
  toolUseId: string;
  replacement: string;
}

export interface ContentReplacementEntry {
  type: "content-replacement";
  sessionId: string;
  timestamp: string;
  replacements: ContentReplacementRecord[];
}

export type Entry =
  | MessageEntry
  | CompactBoundaryEntry
  | SummaryEntry
  | CustomTitleEntry
  | MetadataEntry
  | ToolResultOverflowEntry
  | FileCheckpointEntry
  | ContentReplacementEntry
  | SnipBoundaryEntry;

export interface SessionInfo {
  sessionId: string;
  createdAt: string;
  lastMessageAt: string;
  title?: string;
  messageCount: number;
}

// --- Stream event types ---

export interface ToolResult {
  content: string | ContentPart[];
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
  | { type: "model_switch"; from: string; to: string }
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
    }
  | { type: "session_resumed"; sessionId: string; messageCount: number }
  | { type: "checkpoint_snapshot"; messageId: string }
  | { type: "recovery_filtered"; filterName: string; removedCount: number }
  | {
      type: "interrupted_turn_detected";
      kind: "interrupted_tool" | "interrupted_prompt";
    }
  | {
      type: "git_operation";
      operation: "commit" | "push" | "pr_create" | "merge" | "rebase";
      details: string;
    }
  | {
      type: "structured_output";
      data: unknown;
      schema: OutputFormat;
    }
  | { type: "max_turns_reached"; maxTurns: number; turnCount: number }
  | { type: "auto_compact_failed"; error: Error };

export interface RunOptions {
  signal?: AbortSignal;
  /**
   * Maximum number of model-to-tool turns before the loop terminates.
   * When exceeded, the thread yields a `max_turns_reached` event and stops.
   */
  maxTurns?: number;
  /**
   * Constrain the model to produce structured output.
   *
   * In `"alongside_tools"` mode (default), the outputFormat is passed
   * directly to the provider on every model call — the model may still
   * use tools alongside its structured response.
   *
   * In `"final_response"` mode, a synthetic `StructuredOutput` tool is
   * injected. The agent loop continues using tools normally until the
   * model calls StructuredOutput with the schema-conforming data. This
   * is the recommended mode when the agent needs to reason and use
   * tools before producing the final structured answer.
   */
  outputFormat?: OutputFormat;
  /**
   * Controls how structured output interacts with the tool loop.
   * - `"alongside_tools"` (default): pass outputFormat to the provider;
   *   the model response itself is structured JSON.
   * - `"final_response"`: inject a synthetic StructuredOutput tool; the
   *   model calls it to signal completion with structured data.
   */
  structuredOutputMode?: "alongside_tools" | "final_response";
}
