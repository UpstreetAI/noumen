import type {
  ChatMessage,
  AssistantMessage,
  ToolCallContent,
  StreamEvent,
} from "../session/types.js";
import type { ChatCompletionUsage } from "../providers/types.js";
import type { StreamAccumulator } from "./consume-stream.js";

// ---------------------------------------------------------------------------
// separateToolCalls
// ---------------------------------------------------------------------------

export interface SeparatedToolCalls {
  valid: ToolCallContent[];
  malformed: Array<{ id: string; name: string }>;
}

export function separateToolCalls(
  acc: StreamAccumulator,
  isStreaming: boolean,
): SeparatedToolCalls {
  const valid: ToolCallContent[] = [];
  const malformed: Array<{ id: string; name: string }> = [];

  for (const tc of acc.toolCalls.values()) {
    let isMalformed = tc.malformedJson;
    if (!isMalformed && !isStreaming) {
      try { JSON.parse(tc.arguments); } catch { isMalformed = true; }
    }
    if (isMalformed) {
      malformed.push({ id: tc.id, name: tc.name });
    } else {
      valid.push({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      });
    }
  }

  return { valid, malformed };
}

// ---------------------------------------------------------------------------
// buildAssistantMessage
// ---------------------------------------------------------------------------

export interface BuildAssistantMessageParams {
  acc: StreamAccumulator;
  validToolCalls: ToolCallContent[];
  malformedToolCalls: Array<{ id: string; name: string }>;
  turnId: string;
}

export function buildAssistantMessage(
  params: BuildAssistantMessageParams,
): AssistantMessage {
  const { acc, validToolCalls, malformedToolCalls, turnId } = params;

  const allToolCalls: ToolCallContent[] = [
    ...validToolCalls,
    ...malformedToolCalls.map((m) => ({
      id: m.id,
      type: "function" as const,
      function: { name: m.name, arguments: "{}" },
    })),
  ];

  const textContent = acc.content.join("");
  const thinkingContent = acc.thinking.join("") || undefined;

  return {
    role: "assistant",
    content: textContent || null,
    ...(allToolCalls.length > 0 ? { tool_calls: allToolCalls } : {}),
    ...(thinkingContent ? { thinking_content: thinkingContent } : {}),
    ...(acc.thinkingSignature ? { thinking_signature: acc.thinkingSignature } : {}),
    ...(acc.redactedThinkingData ? { redacted_thinking_data: acc.redactedThinkingData } : {}),
    _turnId: turnId,
  };
}

// ---------------------------------------------------------------------------
// generateMalformedToolResults
// ---------------------------------------------------------------------------

export interface MalformedToolResultsOutput {
  messages: ChatMessage[];
  events: StreamEvent[];
}

export function generateMalformedToolResults(
  malformed: Array<{ id: string; name: string }>,
): MalformedToolResultsOutput {
  const messages: ChatMessage[] = [];
  const events: StreamEvent[] = [];

  for (const m of malformed) {
    const errorResult: ChatMessage = {
      role: "tool",
      tool_call_id: m.id,
      content: `Error: Invalid tool call arguments for ${m.name} (malformed JSON)`,
      isError: true,
    };
    messages.push(errorResult);
    events.push({
      type: "tool_result",
      toolUseId: m.id,
      toolName: m.name,
      result: { content: errorResult.content as string, isError: true },
    } as StreamEvent);
  }

  return { messages, events };
}

// ---------------------------------------------------------------------------
// accumulateUsage
// ---------------------------------------------------------------------------

export interface AccumulateUsageParams {
  usage: ChatCompletionUsage | undefined;
  turnUsage: ChatCompletionUsage;
  model: string;
  messagesLength: number;
}

export interface AccumulateUsageResult {
  events: StreamEvent[];
  lastUsage: ChatCompletionUsage | undefined;
  anchorMessageIndex: number | undefined;
  resetMicrocompactTokensFreed: boolean;
}

export function accumulateUsage(
  params: AccumulateUsageParams,
): AccumulateUsageResult {
  const { usage, turnUsage, model, messagesLength } = params;
  const events: StreamEvent[] = [];

  if (!usage) {
    return {
      events,
      lastUsage: undefined,
      anchorMessageIndex: undefined,
      resetMicrocompactTokensFreed: false,
    };
  }

  turnUsage.prompt_tokens += usage.prompt_tokens;
  turnUsage.completion_tokens += usage.completion_tokens;
  turnUsage.total_tokens += usage.total_tokens;
  turnUsage.cache_read_tokens = (turnUsage.cache_read_tokens ?? 0) + (usage.cache_read_tokens ?? 0);
  turnUsage.cache_creation_tokens = (turnUsage.cache_creation_tokens ?? 0) + (usage.cache_creation_tokens ?? 0);
  turnUsage.thinking_tokens = (turnUsage.thinking_tokens ?? 0) + (usage.thinking_tokens ?? 0);

  events.push({ type: "usage", usage, model } as StreamEvent);

  return {
    events,
    lastUsage: usage,
    anchorMessageIndex: messagesLength - 1,
    resetMicrocompactTokensFreed: true,
  };
}
