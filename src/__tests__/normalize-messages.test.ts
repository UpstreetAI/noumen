import { describe, it, expect } from "vitest";
import type { ChatMessage, AssistantMessage, ToolResultMessage } from "../session/types.js";
import {
  normalizeMessagesForAPI,
  ensureToolResultPairing,
  mergeConsecutiveSameRole,
  filterWhitespaceOnlyAssistants,
  filterOrphanedThinkingAssistants,
} from "../messages/normalize.js";

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
// normalizeMessagesForAPI — full pipeline
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI", () => {
  it("passes a valid array through unchanged (identity)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result).toEqual(messages);
  });

  it("does not mutate the input array", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hello" },
      { role: "assistant", content: null },
    ];
    const copy = [...messages];
    normalizeMessagesForAPI(messages);
    expect(messages).toEqual(copy);
  });

  it("is idempotent", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "instructions" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "  " },
      { role: "user", content: "again" },
      asstWithCalls(["t1", "t2"]),
      toolResult("t1"),
      // missing t2
    ];
    const first = normalizeMessagesForAPI(messages);
    const second = normalizeMessagesForAPI(first);
    expect(second).toEqual(first);
  });

  // --- Step 1: Drop system messages ---

  it("strips system messages from the array", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result.every((m) => m.role !== "system")).toBe(true);
    expect(result).toHaveLength(2);
  });

  // --- Step 2: Deduplicate tool_use IDs ---

  it("strips duplicate tool_use IDs from later assistants", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do things" },
      asstWithCalls(["t1"]),
      toolResult("t1"),
      { role: "user", content: "more" },
      asstWithCalls(["t1"]), // duplicate ID
      toolResult("t1"),
    ];
    const result = normalizeMessagesForAPI(messages);
    const toolUseIds = result
      .filter((m) => m.role === "assistant" && (m as AssistantMessage).tool_calls)
      .flatMap((m) => (m as AssistantMessage).tool_calls!.map((tc) => tc.id));
    expect(toolUseIds).toEqual(["t1"]);
  });

  it("drops assistant entirely when all tool_calls are duplicates and no text", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asstWithCalls(["t1"]),
      toolResult("t1"),
      { role: "user", content: "again" },
      asstWithCalls(["t1"]), // all dupes, no content
    ];
    const result = normalizeMessagesForAPI(messages);
    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
  });

  it("keeps assistant with text when tool_calls stripped as duplicates", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asstWithCalls(["t1"]),
      toolResult("t1"),
      { role: "user", content: "again" },
      { ...asstWithCalls(["t1"]), content: "some text" },
    ];
    const result = normalizeMessagesForAPI(messages);
    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect((assistants[1] as AssistantMessage).tool_calls).toBeUndefined();
    expect((assistants[1] as AssistantMessage).content).toBe("some text");
  });

  // --- Step 3: Strip orphaned tool_results ---

  it("removes tool results with no matching tool_call", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "start" },
      toolResult("orphan_id"),
      { role: "assistant", content: "reply" },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result.find((m) => m.role === "tool")).toBeUndefined();
  });

  it("removes orphaned tool_result at array start", () => {
    const messages: ChatMessage[] = [
      toolResult("orphan"),
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result[0].role).toBe("user");
    expect(result.find((m) => m.role === "tool")).toBeUndefined();
  });

  // --- Step 4: Ensure tool result pairing ---

  it("inserts synthetic results for missing tool_results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "run it" },
      asstWithCalls(["t1", "t2", "t3"]),
      toolResult("t1"),
      // t2 and t3 missing
    ];
    const result = normalizeMessagesForAPI(messages);
    const tools = result.filter((m) => m.role === "tool") as ToolResultMessage[];
    expect(tools).toHaveLength(3);
    expect(tools[1].tool_call_id).toBe("t2");
    expect(tools[1].isError).toBe(true);
    expect(tools[2].tool_call_id).toBe("t3");
    expect(tools[2].isError).toBe(true);
  });

  it("places synthetic results after the last real result", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asstWithCalls(["t1", "t2"]),
      toolResult("t2"),
      // t1 missing, but t2 exists after assistant
    ];
    const result = normalizeMessagesForAPI(messages);
    const tools = result.filter((m) => m.role === "tool") as ToolResultMessage[];
    expect(tools).toHaveLength(2);
    // The synthetic for t1 should come after the real t2
    expect(tools[0].tool_call_id).toBe("t2");
    expect(tools[0].isError).toBeUndefined();
    expect(tools[1].tool_call_id).toBe("t1");
    expect(tools[1].isError).toBe(true);
  });

  // --- Step 5: Filter whitespace-only assistants ---

  it("drops whitespace-only assistant with no tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "  \n  " } as AssistantMessage,
      { role: "user", content: "again" },
      { role: "assistant", content: "real reply" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AssistantMessage).content).toBe("real reply");
  });

  it("keeps assistant with tool_calls even if content is whitespace", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      { ...asstWithCalls(["t1"]), content: "  " },
      toolResult("t1"),
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  // --- Step 6: Filter orphaned thinking-only assistants ---

  it("drops assistant with null content and no tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "think" },
      { role: "assistant", content: null } as AssistantMessage,
      { role: "user", content: "try again" },
      { role: "assistant", content: "real answer" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AssistantMessage).content).toBe("real answer");
  });

  it("keeps assistant with null content if it has tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      asstWithCalls(["t1"]),
      toolResult("t1"),
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  // --- Step 7: Merge consecutive same-role ---

  it("merges consecutive user messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "assistant", content: "reply" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(Array.isArray(result[0].content)).toBe(true);
    const parts = result[0].content as { type: string; text: string }[];
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe("first");
    expect(parts[1].text).toBe("second");
  });

  it("merges consecutive assistant messages after filter removes a user between them", () => {
    // After dropping the system message and whitespace assistant, the two
    // user messages become adjacent and get merged.
    const messages: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "  " } as AssistantMessage,
      { role: "user", content: "b" },
      { role: "assistant", content: "reply" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    // The two users got merged because the whitespace assistant was removed
    const userContent = result[0].content;
    expect(Array.isArray(userContent)).toBe(true);
  });

  // --- Step 8: Ensure non-empty assistant content ---

  it("sets null content to empty string on assistant with tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asstWithCalls(["t1"]),
      toolResult("t1"),
    ];
    const result = normalizeMessagesForAPI(messages);
    const asst = result.find((m) => m.role === "assistant") as AssistantMessage;
    expect(asst.content).toBe("");
  });

  // --- Step 9: Ensure starts with user ---

  it("prepends placeholder user when array starts with assistant", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "I started" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("[Conversation resumed]");
    expect(result[1].role).toBe("assistant");
  });

  it("prepends placeholder for empty array", () => {
    const result = normalizeMessagesForAPI([]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("does not prepend when array already starts with user", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result[0].content).toBe("hello");
  });

  // --- Complex multi-issue scenarios ---

  it("handles provider error leaving partial assistant with missing tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "run 3 tools" },
      {
        role: "assistant",
        content: "I'll run them",
        tool_calls: [tc("t1"), tc("t2"), tc("t3")],
      } as AssistantMessage,
      toolResult("t1"),
      // t2 and t3 missing (provider error mid-stream)
    ];
    const result = normalizeMessagesForAPI(messages);
    const tools = result.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(3);
  });

  it("handles abort with streaming tools and interruption message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "long task" },
      asstWithCalls(["t1", "t2"]),
      toolResult("t1"),
      // t2 was in flight when abort happened
      { role: "user", content: "[Session interrupted by user]" },
    ];
    const result = normalizeMessagesForAPI(messages);
    // Should have synthetic for t2 inserted before the interruption user
    const tools = result.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(2);
    // Both users should be merged
    const users = result.filter((m) => m.role === "user");
    // First user stays, interruption user comes after tools
    expect(users.length).toBeGreaterThanOrEqual(1);
  });

  it("handles malformed JSON recovery with error tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [tc("t1", "Bash", "{}"), tc("t2", "Bash", "{}")],
      } as AssistantMessage,
      toolResult("t1", "Error: Invalid tool call arguments for Bash (malformed JSON)", true),
      toolResult("t2", "Error: Invalid tool call arguments for Bash (malformed JSON)", true),
      { role: "user", content: "[auto-continue after malformed tool calls]" },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(result.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("fixes a deeply corrupted conversation", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "instructions" },
      toolResult("orphan_before_assistant"),
      { role: "user", content: "start" },
      { role: "assistant", content: null } as AssistantMessage, // thinking artifact
      { role: "assistant", content: "  " } as AssistantMessage, // whitespace
      { role: "user", content: "ok" },
      asstWithCalls(["t1"]),
      // no result for t1
      asstWithCalls(["t1"]), // duplicate
      { role: "user", content: "end" },
    ];
    const result = normalizeMessagesForAPI(messages);
    // Verify structure
    expect(result[0].role).toBe("user");
    expect(result.every((m) => m.role !== "system")).toBe(true);
    // Should have no orphaned tool_results
    // Should have no duplicate tool_use IDs
    const toolUseIds = result
      .filter((m) => m.role === "assistant")
      .flatMap((m) => ((m as AssistantMessage).tool_calls ?? []).map((tc) => tc.id));
    const uniqueIds = new Set(toolUseIds);
    expect(toolUseIds.length).toBe(uniqueIds.size);
    // Every tool_use should have a result
    for (const id of toolUseIds) {
      expect(result.some((m) => m.role === "tool" && (m as ToolResultMessage).tool_call_id === id)).toBe(true);
    }
  });
});

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

  it("inserts synthetics for multiple assistants", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "a" },
      asstWithCalls(["t1"]),
      { role: "user", content: "b" },
      asstWithCalls(["t2"]),
    ];
    const result = ensureToolResultPairing(messages);
    const tools = result.filter((m) => m.role === "tool") as ToolResultMessage[];
    expect(tools).toHaveLength(2);
    expect(tools[0].tool_call_id).toBe("t1");
    expect(tools[1].tool_call_id).toBe("t2");
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
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe("a");
    expect(parts[1].text).toBe("b");
  });
});
