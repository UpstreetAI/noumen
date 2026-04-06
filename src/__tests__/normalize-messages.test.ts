import { describe, it, expect } from "vitest";
import type { ChatMessage, AssistantMessage, ToolResultMessage } from "../session/types.js";
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
// normalizeMessagesForAPI — full pipeline
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI", () => {
  it("passes a valid array through unchanged (identity)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(first);
    const second = normalizeMessagesForAPI(first);
    assertValidMessageSequence(second);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
    expect(result.find((m) => m.role === "tool")).toBeUndefined();
  });

  it("removes orphaned tool_result at array start", () => {
    const messages: ChatMessage[] = [
      toolResult("orphan"),
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
    const asst = result.find((m) => m.role === "assistant") as AssistantMessage;
    expect(asst.content).toBe("");
  });

  // --- Step 9: Ensure starts with user ---

  it("prepends placeholder user when array starts with assistant", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "I started" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("[Conversation resumed]");
    expect(result[1].role).toBe("assistant");
  });

  it("prepends placeholder for empty array", () => {
    const result = normalizeMessagesForAPI([]);
    assertValidMessageSequence(result);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("does not prepend when array already starts with user", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    assertValidMessageSequence(result);
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
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe("a");
    expect(parts[1].text).toBe("b");
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

// ---------------------------------------------------------------------------
// Bug fix: duplicate tool_result deduplication
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI — duplicate tool_result dedup", () => {
  it("keeps only the first tool_result for a given tool_call_id", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asstWithCalls(["t1"]),
      toolResult("t1", "first result"),
      toolResult("t1", "duplicate result"),
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const toolResults = result.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as import("../session/types.js").ToolResultMessage).content).toBe("first result");
  });

  it("preserves distinct tool_results for different IDs", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asstWithCalls(["t1", "t2"]),
      toolResult("t1", "result1"),
      toolResult("t2", "result2"),
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const toolResults = result.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(2);
  });

  it("handles multiple duplicates across different IDs", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asstWithCalls(["t1", "t2"]),
      toolResult("t1", "first-1"),
      toolResult("t2", "first-2"),
      toolResult("t1", "dup-1"),
      toolResult("t2", "dup-2"),
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const toolResults = result.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Bug fix: trailing thinking-only assistant stripped
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI — trailing thinking-only assistant", () => {
  it("removes trailing assistant with empty content and thinking only", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "think about this" },
      { role: "assistant", content: "", thinking_content: "deep thought", thinking_signature: "sig123" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("preserves thinking on trailing assistant with substantive text", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "think about this" },
      { role: "assistant", content: "Here is my answer", thinking_content: "deep thought" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const last = result[result.length - 1] as AssistantMessage;
    expect(last.thinking_content).toBe("deep thought");
  });

  it("preserves thinking on trailing assistant with tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do something" },
      { role: "assistant", content: null, thinking_content: "planning", tool_calls: [tc("t1")] } as AssistantMessage,
      toolResult("t1", "done"),
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const assistants = result.filter((m) => m.role === "assistant");
    expect((assistants[0] as AssistantMessage).thinking_content).toBe("planning");
  });

  it("does not strip thinking from non-trailing assistant", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "step 1" },
      { role: "assistant", content: "", thinking_content: "thought" } as AssistantMessage,
      { role: "user", content: "step 2" },
      { role: "assistant", content: "response" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect((assistants[0] as AssistantMessage).thinking_content).toBe("thought");
  });

  it("removes trailing assistant with redacted_thinking_data and no text", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "think" },
      { role: "assistant", content: null, thinking_content: "secret", redacted_thinking_data: "redacted" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// Ordering interaction: thinking removal before whitespace filtering
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI — thinking/whitespace ordering", () => {
  it("removes trailing assistant with whitespace text + thinking_content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "think about this" },
      {
        role: "assistant",
        content: "  \n  ",
        thinking_content: "deep analysis",
        thinking_signature: "sig_abc",
      } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("think about this");
  });

  it("cleans up mid-conversation thinking-only + whitespace assistants and merges users", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "step 1" },
      { role: "assistant", content: null, thinking_content: "thought" } as AssistantMessage,
      { role: "assistant", content: "   " } as AssistantMessage,
      { role: "user", content: "step 2" },
      { role: "assistant", content: "real reply" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    expect(result[0].role).toBe("user");
    const lastAsst = result.find((m) => m.role === "assistant") as AssistantMessage;
    expect(lastAsst.content).toBe("real reply");
    expect(result.filter((m) => m.role === "assistant")).toHaveLength(1);
    const users = result.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(Array.isArray(users[0].content)).toBe(true);
  });

  it("handles cascading removal when stripped tail exposes another thinking-only assistant", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "real answer" } as AssistantMessage,
      { role: "user", content: "followup" },
      { role: "assistant", content: null, thinking_content: "thought A" } as AssistantMessage,
      { role: "assistant", content: "", thinking_content: "thought B" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AssistantMessage).content).toBe("real answer");
    expect(result[result.length - 1].role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// mergeAssistantsByTurnId — non-adjacent assistant merge
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI — _turnId merge", () => {
  it("merges non-adjacent assistants with the same _turnId across tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "part 1", tool_calls: [tc("t1")], _turnId: "s:1" } as AssistantMessage,
      toolResult("t1", "result 1"),
      { role: "assistant", content: "part 2", _turnId: "s:1" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const assistants = result.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toContain("part 1");
    expect(assistants[0].content).toContain("part 2");
    expect(assistants[0].tool_calls).toHaveLength(1);
  });

  it("does not merge assistants with different _turnIds", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "turn A", tool_calls: [tc("t1")], _turnId: "s:1" } as AssistantMessage,
      toolResult("t1", "result"),
      { role: "assistant", content: "turn B", tool_calls: [tc("t2")], _turnId: "s:2" } as AssistantMessage,
      toolResult("t2", "result"),
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const assistants = result.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants).toHaveLength(2);
  });

  it("passes through messages without _turnId unchanged", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "no turn id", tool_calls: [tc("t1")] } as AssistantMessage,
      toolResult("t1", "result"),
      { role: "assistant", content: "also no turn id" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const assistants = result.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants).toHaveLength(2);
  });

  it("strips _turnId from the final output", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "reply", _turnId: "s:1" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const asst = result.find((m) => m.role === "assistant") as AssistantMessage;
    expect(asst._turnId).toBeUndefined();
  });

  it("merges tool_calls from both assistant halves", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("t1")], _turnId: "s:1" } as AssistantMessage,
      toolResult("t1", "ok"),
      { role: "assistant", content: null, tool_calls: [tc("t2")], _turnId: "s:1" } as AssistantMessage,
      toolResult("t2", "ok"),
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const assistants = result.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants).toHaveLength(1);
    expect(assistants[0].tool_calls).toHaveLength(2);
  });

  it("merges thinking content from both halves", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "a", thinking_content: "think1", _turnId: "s:1" } as AssistantMessage,
      { role: "tool", tool_call_id: "t1", content: "ok" } as ChatMessage,
      { role: "assistant", content: "b", thinking_content: "think2", _turnId: "s:1" } as AssistantMessage,
    ];
    // We need a tool_call for t1 to avoid it being orphaned; let's restructure:
    const messages2: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "a", tool_calls: [tc("t1")], thinking_content: "think1", _turnId: "s:1" } as AssistantMessage,
      toolResult("t1", "ok"),
      { role: "assistant", content: "b", thinking_content: "think2", _turnId: "s:1" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages2);
    assertValidMessageSequence(result);
    const asst = result.find((m) => m.role === "assistant") as AssistantMessage;
    expect(asst.thinking_content).toContain("think1");
    expect(asst.thinking_content).toContain("think2");
  });
});

// ---------------------------------------------------------------------------
// normalizeToolInputForAPI — tool input stripping
// ---------------------------------------------------------------------------

describe("normalizeToolInputForAPI", () => {
  it("strips _meta field from any tool", () => {
    const input = JSON.stringify({ command: "ls", _meta: { source: "test" } });
    const result = normalizeToolInputForAPI("Bash", input);
    const parsed = JSON.parse(result);
    expect(parsed._meta).toBeUndefined();
    expect(parsed.command).toBe("ls");
  });

  it("strips _source and _injected from any tool", () => {
    const input = JSON.stringify({ x: 1, _source: "hook", _injected: true });
    const result = normalizeToolInputForAPI("ReadFile", input);
    const parsed = JSON.parse(result);
    expect(parsed._source).toBeUndefined();
    expect(parsed._injected).toBeUndefined();
    expect(parsed.x).toBe(1);
  });

  it("strips planFilePath from ExitPlanMode", () => {
    const input = JSON.stringify({ plan: "do stuff", planFilePath: "/tmp/plan.md" });
    const result = normalizeToolInputForAPI("ExitPlanMode", input);
    const parsed = JSON.parse(result);
    expect(parsed.planFilePath).toBeUndefined();
    expect(parsed.plan).toBe("do stuff");
  });

  it("strips legacy fields from EditFile when edits array is present", () => {
    const input = JSON.stringify({
      edits: [{ old: "a", new: "b" }],
      old_string: "a",
      new_string: "b",
      replace_all: false,
    });
    const result = normalizeToolInputForAPI("EditFile", input);
    const parsed = JSON.parse(result);
    expect(parsed.old_string).toBeUndefined();
    expect(parsed.new_string).toBeUndefined();
    expect(parsed.replace_all).toBeUndefined();
    expect(parsed.edits).toBeDefined();
  });

  it("preserves old_string/new_string on EditFile when edits is absent (current format)", () => {
    const input = JSON.stringify({
      file_path: "/foo.ts",
      old_string: "before",
      new_string: "after",
    });
    const result = normalizeToolInputForAPI("EditFile", input);
    const parsed = JSON.parse(result);
    expect(parsed.old_string).toBe("before");
    expect(parsed.new_string).toBe("after");
  });

  it("returns original string when no fields to strip", () => {
    const input = JSON.stringify({ file_path: "/foo.txt" });
    const result = normalizeToolInputForAPI("ReadFile", input);
    expect(result).toBe(input);
  });

  it("handles malformed JSON gracefully", () => {
    const input = "not json";
    const result = normalizeToolInputForAPI("Bash", input);
    expect(result).toBe(input);
  });
});

describe("normalizeMessagesForAPI — sanitizeErrorToolResultContent", () => {
  it("strips non-text content from isError tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling tool",
        tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } }],
      } as AssistantMessage,
      {
        role: "tool",
        tool_call_id: "t1",
        content: [
          { type: "text", text: "Error: command failed" },
          { type: "image", data: "abc123", media_type: "image/png" },
        ],
        isError: true,
      } as ToolResultMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const toolMsg = result.find((m) => m.role === "tool") as ToolResultMessage;
    expect(toolMsg.content).toBe("Error: command failed");
    expect(typeof toolMsg.content).toBe("string");
  });

  it("preserves non-error tool results with images", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling tool",
        tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } }],
      } as AssistantMessage,
      {
        role: "tool",
        tool_call_id: "t1",
        content: [
          { type: "text", text: "result" },
          { type: "image", data: "abc123", media_type: "image/png" },
        ],
      } as ToolResultMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const toolMsg = result.find((m) => m.role === "tool") as ToolResultMessage;
    expect(Array.isArray(toolMsg.content)).toBe(true);
  });

  it("handles isError with only image content (no text)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling tool",
        tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } }],
      } as AssistantMessage,
      {
        role: "tool",
        tool_call_id: "t1",
        content: [
          { type: "image", data: "abc123", media_type: "image/png" },
        ],
        isError: true,
      } as ToolResultMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const toolMsg = result.find((m) => m.role === "tool") as ToolResultMessage;
    expect(toolMsg.content).toBe("Error (details unavailable)");
  });

  it("joins multiple text parts in error tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling tool",
        tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } }],
      } as AssistantMessage,
      {
        role: "tool",
        tool_call_id: "t1",
        content: [
          { type: "text", text: "Error line 1" },
          { type: "image", data: "abc123", media_type: "image/png" },
          { type: "text", text: "Error line 2" },
        ],
        isError: true,
      } as ToolResultMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const toolMsg = result.find((m) => m.role === "tool") as ToolResultMessage;
    expect(toolMsg.content).toBe("Error line 1\n\nError line 2");
  });
});

describe("normalizeMessagesForAPI — tool input stripping integration", () => {
  it("strips _meta from tool call args in the full pipeline", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "t1",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: "ls", _meta: { x: 1 } }) },
        }],
      } as AssistantMessage,
      toolResult("t1", "ok"),
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    const asst = result.find((m) => m.role === "assistant") as AssistantMessage;
    const args = JSON.parse(asst.tool_calls![0].function.arguments);
    expect(args._meta).toBeUndefined();
    expect(args.command).toBe("ls");
  });
});
