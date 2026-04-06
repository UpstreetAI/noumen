import type {
  ChatMessage,
  AssistantMessage,
  ToolCallContent,
  StreamEvent,
} from "../session/types.js";
import type { AIProvider } from "../providers/types.js";
import type { StreamingExecResult } from "../tools/streaming-executor.js";
import type { HookDefinition } from "../hooks/types.js";
import { generateMissingToolResults } from "../session/recovery.js";
import { runNotificationHooks } from "../hooks/runner.js";
import { tryReactiveCompact } from "../compact/reactive-compact.js";
import type { SessionStorage } from "../session/storage.js";

// ---------------------------------------------------------------------------
// buildPartialResults — pure function, no side effects
// ---------------------------------------------------------------------------

export interface PartialResultsInput {
  accumulatedToolCalls: Map<number, { id: string; name: string; arguments: string }>;
  accumulatedContent: string[];
  completedStreamingResults: StreamingExecResult[];
  reason: string;
  /**
   * When the provider error catch fires with zero accumulated tool calls,
   * the existing message history may contain an assistant with pending
   * tool_calls. Pass the current messages array so we can generate
   * synthetic results for those too.
   */
  existingMessages?: ChatMessage[];
  /**
   * When false, omit the "[Response interrupted: ...]" suffix from the
   * assistant content. Useful for the abort path where getRemainingResults()
   * already provides both real and synthetic tool results.
   */
  includeInterruptionTag?: boolean;
}

export interface PartialResultsOutput {
  messages: ChatMessage[];
}

export function buildPartialResults(input: PartialResultsInput): PartialResultsOutput {
  const { accumulatedToolCalls, accumulatedContent, completedStreamingResults, reason } = input;
  const includeTag = input.includeInterruptionTag !== false;
  const messages: ChatMessage[] = [];

  if (accumulatedToolCalls.size > 0 || accumulatedContent.length > 0) {
    const partialCalls: ToolCallContent[] = Array.from(accumulatedToolCalls.values()).map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));

    const partialText = accumulatedContent.join("");

    let content: string | null;
    if (partialCalls.length > 0 && includeTag) {
      content = partialText
        ? `${partialText}\n[Response interrupted: ${reason}]`
        : `[Response interrupted: ${reason}]`;
    } else {
      content = partialText || null;
    }

    const partialAssistant: AssistantMessage = {
      role: "assistant",
      content,
      ...(partialCalls.length > 0 ? { tool_calls: partialCalls } : {}),
    };
    messages.push(partialAssistant);

    if (partialCalls.length > 0) {
      const realToolMsgs: ChatMessage[] = [];
      for (const completed of completedStreamingResults) {
        const toolResultMsg: ChatMessage = {
          role: "tool",
          tool_call_id: completed.toolCall.id,
          content: completed.result.content,
          ...(completed.result.isError ? { isError: true } : {}),
        };
        messages.push(toolResultMsg);
        realToolMsgs.push(toolResultMsg);
      }

      const syntheticResults = generateMissingToolResults(partialAssistant, realToolMsgs, reason);
      for (const sr of syntheticResults) {
        messages.push(sr);
      }
    }
  } else if (input.existingMessages) {
    const lastMsg = input.existingMessages[input.existingMessages.length - 1];
    if (lastMsg && lastMsg.role === "assistant" && (lastMsg as AssistantMessage).tool_calls) {
      const syntheticResults = generateMissingToolResults(
        lastMsg as AssistantMessage,
        input.existingMessages,
        reason,
      );
      for (const sr of syntheticResults) {
        messages.push(sr);
      }
    }
  }

  return { messages };
}

// ---------------------------------------------------------------------------
// tryReactiveCompactRecovery
// ---------------------------------------------------------------------------

export interface ReactiveCompactInput {
  provider: AIProvider;
  model: string;
  messages: ChatMessage[];
  storage: SessionStorage;
  sessionId: string;
  signal: AbortSignal;
  hooks: HookDefinition[];
}

export interface ReactiveCompactOutput {
  recovered: boolean;
  messages?: ChatMessage[];
  events: StreamEvent[];
}

export async function tryReactiveCompactRecovery(
  input: ReactiveCompactInput,
): Promise<ReactiveCompactOutput> {
  const events: StreamEvent[] = [];

  await runNotificationHooks(input.hooks, "PreCompact", {
    event: "PreCompact",
    sessionId: input.sessionId,
  });
  events.push({ type: "compact_start" } as StreamEvent);

  const recovered = await tryReactiveCompact(
    input.provider,
    input.model,
    input.messages,
    input.storage,
    input.sessionId,
    { signal: input.signal },
  );

  events.push({ type: "compact_complete" } as StreamEvent);
  await runNotificationHooks(input.hooks, "PostCompact", {
    event: "PostCompact",
    sessionId: input.sessionId,
  });

  if (recovered) {
    return { recovered: true, messages: recovered.messages, events };
  }
  return { recovered: false, events };
}
