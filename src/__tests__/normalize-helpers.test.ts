import { describe, it, expect } from "vitest";
import type { ChatMessage, AssistantMessage, ToolResultMessage, ContentPart } from "../session/types.js";
import {
  normalizeMessagesForAPI,
  ensureToolResultPairing,
  mergeConsecutiveSameRole,
  filterWhitespaceOnlyAssistants,
  filterOrphanedThinkingAssistants,
} from "../messages/normalize.js";
import { normalizeToolInputForAPI } from "../messages/tool-input-normalize.js";
import { assertValidMessageSequence } from "../messages/invariants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tc(id: string, name = "Bash", args = '{"command":"ls"}') {
  return { id, type: "function" as const, function: { name, arguments: args } };
}

function toolResult(id: string, content = "ok", isError = false): ToolResultMessage {
  return { role: "tool", tool_call_id: id, content, ...(isError ? { isError: true } : {}) };
}

function asstWithCalls(ids: string[], content: string | null = null): AssistantMessage {
  return {
    role: "assistant",
    content,
    tool_calls: ids.map((id) => tc(id)),
  };
}

// ---------------------------------------------------------------------------
// Individual step functions (exported for direct use)
// ---------------------------------------------------------------------------

describe("ensureToolResultPairing", () => {
  it("returns same reference when no repairs needed", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asstWithCalls(["t1"]),
      toolResult("t1"),
    ];
    expect(ensureToolResultPairing(messages)).toBe(messages);
  });

  it("drops all-unresolved empty assistants (strict fallback)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "a" },
      asstWithCalls(["t1"]),
      { role: "user", content: "b" },
      asstWithCalls(["t2"]),
    ];
    const result = ensureToolResultPairing(messages);
    // Both assistants have null content and all-unresolved calls → dropped
    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
    const tools = result.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(0);
  });

  it("inserts synthetics for partially resolved assistants", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asstWithCalls(["t1", "t2"]),
      toolResult("t1"),
    ];
    const result = ensureToolResultPairing(messages);
    const tools = result.filter((m) => m.role === "tool") as ToolResultMessage[];
    expect(tools).toHaveLength(2);
    expect(tools[0].tool_call_id).toBe("t1");
    expect(tools[1].tool_call_id).toBe("t2");
    expect(tools[1].isError).toBe(true);
  });

  it("inserts synthetics for all-unresolved assistant with text content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "a" },
      { ...asstWithCalls(["t1"]), content: "I'll help with that" } as AssistantMessage,
    ];
    const result = ensureToolResultPairing(messages);
    const tools = result.filter((m) => m.role === "tool") as ToolResultMessage[];
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_call_id).toBe("t1");
    expect(tools[0].isError).toBe(true);
  });
});

describe("filterWhitespaceOnlyAssistants", () => {
  it("removes empty-string assistants", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "" } as AssistantMessage,
    ];
    const result = filterWhitespaceOnlyAssistants(messages);
    expect(result).toHaveLength(1);
  });

  it("preserves assistants with real content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" } as AssistantMessage,
    ];
    const result = filterWhitespaceOnlyAssistants(messages);
    expect(result).toHaveLength(2);
  });
});

describe("filterOrphanedThinkingAssistants", () => {
  it("removes null-content assistants", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null } as AssistantMessage,
    ];
    const result = filterOrphanedThinkingAssistants(messages);
    expect(result).toHaveLength(1);
  });

  it("keeps null-content assistants with tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asstWithCalls(["t1"]),
    ];
    const result = filterOrphanedThinkingAssistants(messages);
    expect(result).toHaveLength(2);
  });
});

describe("mergeConsecutiveSameRole", () => {
  it("merges adjacent user messages into ContentPart[]", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    expect(Array.isArray(result[0].content)).toBe(true);
  });

  it("merges adjacent assistant messages preserving tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "first", tool_calls: [tc("t1")] } as AssistantMessage,
      { role: "assistant", content: "second", tool_calls: [tc("t2")] } as AssistantMessage,
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    const asst = result[0] as AssistantMessage;
    expect(asst.content).toBe("first\nsecond");
    expect(asst.tool_calls).toHaveLength(2);
  });

  it("merges thinking_content fields", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "a", thinking_content: "think1" } as AssistantMessage,
      { role: "assistant", content: "b", thinking_content: "think2" } as AssistantMessage,
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect((result[0] as AssistantMessage).thinking_content).toBe("think1\nthink2");
  });

  it("preserves thinking_signature from later message", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "a", thinking_signature: "sig1" } as AssistantMessage,
      { role: "assistant", content: "b", thinking_signature: "sig2" } as AssistantMessage,
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect((result[0] as AssistantMessage).thinking_signature).toBe("sig2");
  });

  it("does not merge tool messages", () => {
    const messages: ChatMessage[] = [
      toolResult("t1", "one"),
      toolResult("t2", "two"),
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(2);
  });

  it("returns same array for single message", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "solo" }];
    expect(mergeConsecutiveSameRole(messages)).toBe(messages);
  });

  it("handles user messages with ContentPart[] content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", content: "b" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    const parts = result[0].content as { type: string; text: string }[];
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe("a\nb");
  });

  it("inserts newline separator between adjacent text parts when merging user messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "2 + 2" },
      { role: "user", content: "3 + 3" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    const parts = result[0].content as { type: string; text?: string }[];
    const fullText = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(fullText).toBe("2 + 2\n3 + 3");
  });

  it("does not insert separator between image and text parts", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "image", data: "abc", media_type: "image/png" }] },
      { role: "user", content: "caption" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    const parts = result[0].content as { type: string; text?: string }[];
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("image");
    expect(parts[1]).toEqual({ type: "text", text: "caption" });
  });

  it("merges three consecutive user messages with correct separators", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "alpha" },
      { role: "user", content: "beta" },
      { role: "user", content: "gamma" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    const parts = result[0].content as { type: string; text?: string }[];
    const fullText = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(fullText).toBe("alpha\nbeta\ngamma");
  });
});

// ---------------------------------------------------------------------------
// Bug fix: thinking-only assistants preserved by whitespace filter
// ---------------------------------------------------------------------------

describe("filterWhitespaceOnlyAssistants — thinking preservation", () => {
  it("preserves assistant with empty content but valid thinking_content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", thinking_content: "deep analysis" } as AssistantMessage,
    ];
    const result = filterWhitespaceOnlyAssistants(messages);
    expect(result).toHaveLength(2);
    expect((result[1] as AssistantMessage).thinking_content).toBe("deep analysis");
  });

  it("preserves assistant with null content but valid thinking_content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, thinking_content: "reasoning" } as AssistantMessage,
    ];
    const result = filterWhitespaceOnlyAssistants(messages);
    expect(result).toHaveLength(2);
  });

  it("still drops whitespace-only assistants with no thinking", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "   " } as AssistantMessage,
    ];
    const result = filterWhitespaceOnlyAssistants(messages);
    expect(result).toHaveLength(1);
  });
});
