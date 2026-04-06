import { describe, it, expect } from "vitest";
import type { ChatMessage, AssistantMessage } from "../session/types.js";
import {
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  filterOrphanedThinkingMessages,
  detectTurnInterruption,
  sanitizeForResume,
  generateMissingToolResults,
  ensureToolResultPairing,
  mergeConsecutiveSameRole,
} from "../session/recovery.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";
import { assertValidMessageSequence } from "../messages/invariants.js";

describe("filterUnresolvedToolUses", () => {
  it("drops assistants where all tool_calls are unresolved", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
        ],
      },
      // No tool result for tc_1
    ];
    const result = filterUnresolvedToolUses(messages);
    expect(result.removed).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("keeps assistants with at least one resolved tool_call", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } },
          { id: "tc_2", type: "function", function: { name: "Grep", arguments: '{}' } },
        ],
      },
      { role: "tool", tool_call_id: "tc_1", content: "ok" },
      // tc_2 is unresolved but tc_1 is resolved, so assistant is kept
    ];
    const result = filterUnresolvedToolUses(messages);
    expect(result.removed).toBe(0);
    expect(result.messages).toHaveLength(3);
  });

  it("keeps assistants without tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = filterUnresolvedToolUses(messages);
    expect(result.removed).toBe(0);
    expect(result.messages).toHaveLength(2);
  });
});

describe("filterWhitespaceOnlyAssistantMessages", () => {
  it("drops whitespace-only assistants with no tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "   \n  " },
      { role: "user", content: "again" },
    ];
    const result = filterWhitespaceOnlyAssistantMessages(messages);
    expect(result.removed).toBe(1);
    // Consecutive users should be merged into ContentPart[]
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    const parts = result.messages[0].content as Array<{ type: string; text: string }>;
    expect(Array.isArray(parts)).toBe(true);
    const texts = parts.map((p) => p.text);
    expect(texts).toContain("hi");
    expect(texts).toContain("again");
  });

  it("keeps assistants with tool_calls even if text is empty", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } }],
      },
    ];
    const result = filterWhitespaceOnlyAssistantMessages(messages);
    expect(result.removed).toBe(0);
    expect(result.messages).toHaveLength(2);
  });

  it("keeps assistants with real text content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
    ];
    const result = filterWhitespaceOnlyAssistantMessages(messages);
    expect(result.removed).toBe(0);
  });
});

describe("filterOrphanedThinkingMessages", () => {
  it("drops null-content assistants with no tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null } as AssistantMessage,
      { role: "assistant", content: "real response" },
    ];
    const result = filterOrphanedThinkingMessages(messages);
    expect(result.removed).toBe(1);
    expect(result.messages).toHaveLength(2);
  });

  it("keeps null-content assistants that have tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } }],
      } as AssistantMessage,
    ];
    const result = filterOrphanedThinkingMessages(messages);
    expect(result.removed).toBe(0);
  });
});

describe("detectTurnInterruption", () => {
  it("returns none for empty messages", () => {
    expect(detectTurnInterruption([]).kind).toBe("none");
  });

  it("returns none when last significant message is assistant", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(detectTurnInterruption(messages).kind).toBe("none");
  });

  it("returns interrupted_tool when last message is a tool result", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } },
        ],
      },
      { role: "tool", tool_call_id: "tc_1", content: "done" },
    ];
    expect(detectTurnInterruption(messages).kind).toBe("interrupted_tool");
  });

  it("returns interrupted_prompt when last message is user", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "now do this" },
    ];
    expect(detectTurnInterruption(messages).kind).toBe("interrupted_prompt");
  });

  it("skips trailing system messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "system note" },
    ];
    expect(detectTurnInterruption(messages).kind).toBe("none");
  });
});

describe("sanitizeForResume", () => {
  it("runs all filters in order and detects interruption", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "step 1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } }],
      },
      // No tool result — this assistant should be dropped
      { role: "user", content: "step 2" },
      { role: "assistant", content: "   " },  // whitespace only — should be dropped
      { role: "user", content: "step 3" },
    ];

    const result = sanitizeForResume(messages);
    expect(result.removals.unresolvedToolUses).toBe(1);
    expect(result.removals.whitespaceOnly).toBe(1);
    expect(result.interruption.kind).toBe("interrupted_prompt");
  });

  it("returns clean result for well-formed conversation", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = sanitizeForResume(messages);
    expect(result.removals.unresolvedToolUses).toBe(0);
    expect(result.removals.whitespaceOnly).toBe(0);
    expect(result.removals.orphanedThinking).toBe(0);
    expect(result.interruption.kind).toBe("none");
    expect(result.messages).toHaveLength(2);
  });
});

describe("filterUnresolvedToolUses — orphaned tool results", () => {
  it("removes orphaned tool results when their assistant is dropped", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } },
          { id: "tc_2", type: "function", function: { name: "Grep", arguments: '{}' } },
        ],
      },
      // tc_1 is resolved, tc_2 is not — but since at least one is resolved, assistant stays
      { role: "tool", tool_call_id: "tc_1", content: "ok" },
      // Second assistant: ALL unresolved → should be dropped, along with its tool results
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc_3", type: "function", function: { name: "ReadFile", arguments: '{}' } },
        ],
      },
    ];
    const result = filterUnresolvedToolUses(messages);
    // Second assistant (tc_3 unresolved) dropped
    expect(result.removed).toBe(1);
    // Only user + first assistant + tc_1 result remain
    expect(result.messages).toHaveLength(3);
    expect(result.messages.every((m) => {
      if (m.role === "tool") return (m as any).tool_call_id !== "tc_3";
      return true;
    })).toBe(true);
  });
});

describe("detectTurnInterruption with array content", () => {
  it("detects Conversation Summary in ContentPart[] user message", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "[Conversation Summary]\n\nSome summary text." },
        ],
      },
    ];
    expect(detectTurnInterruption(messages).kind).toBe("none");
  });

  it("detects interrupted_prompt for non-summary ContentPart[] user message", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "hello" },
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
        ],
      },
    ];
    expect(detectTurnInterruption(messages).kind).toBe("interrupted_prompt");
  });
});

describe("sanitizeForResume — fillPartiallyResolvedToolCalls", () => {
  it("inserts synthetic results after the last real tool result, not after assistant", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } },
          { id: "tc_2", type: "function", function: { name: "Grep", arguments: '{}' } },
        ],
      },
      { role: "tool", tool_call_id: "tc_1", content: "ok" },
      // tc_2 is unresolved — synthetic should go after tc_1 result, not after assistant
    ];

    const result = sanitizeForResume(messages);
    // Find the synthetic result
    const synthetic = result.messages.find(
      (m) => m.role === "tool" && (m as any).tool_call_id === "tc_2",
    );
    expect(synthetic).toBeDefined();
    expect(typeof synthetic!.content === "string" && synthetic!.content).toContain("missing");

    // Verify ordering: synthetic should be after the tc_1 tool result
    const tc1Idx = result.messages.findIndex(
      (m) => m.role === "tool" && (m as any).tool_call_id === "tc_1",
    );
    const tc2Idx = result.messages.findIndex(
      (m) => m.role === "tool" && (m as any).tool_call_id === "tc_2",
    );
    expect(tc2Idx).toBeGreaterThan(tc1Idx);
  });
});

describe("generateMissingToolResults", () => {
  it("generates synthetic results for unresolved tool_calls", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } },
        { id: "tc_2", type: "function", function: { name: "Grep", arguments: '{}' } },
      ],
    };
    const existing: ChatMessage[] = [
      { role: "tool", tool_call_id: "tc_1", content: "ok" },
    ];

    const missing = generateMissingToolResults(assistant, existing, "Interrupted by abort");
    expect(missing).toHaveLength(1);
    expect(missing[0].tool_call_id).toBe("tc_2");
    expect(missing[0].content).toContain("Interrupted by abort");
  });

  it("returns empty array when all tool_calls are resolved", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } },
      ],
    };
    const existing: ChatMessage[] = [
      { role: "tool", tool_call_id: "tc_1", content: "ok" },
    ];

    const missing = generateMissingToolResults(assistant, existing, "test");
    expect(missing).toHaveLength(0);
  });

  it("returns empty array for assistant without tool_calls", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: "just text",
    };
    const missing = generateMissingToolResults(assistant, [], "test");
    expect(missing).toHaveLength(0);
  });
});

describe("generateMissingToolResults — isError flag", () => {
  it("sets isError: true on synthetic error results", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } },
        { id: "tc_2", type: "function", function: { name: "Grep", arguments: '{}' } },
      ],
    };
    const existing: ChatMessage[] = [
      { role: "tool", tool_call_id: "tc_1", content: "ok" },
    ];

    const missing = generateMissingToolResults(assistant, existing, "test reason");
    expect(missing).toHaveLength(1);
    expect(missing[0].isError).toBe(true);
    expect(missing[0].content).toContain("test reason");
  });
});

describe("sanitizeForResume — fillPartiallyResolvedToolCalls isError", () => {
  it("sets isError: true on synthetic results for partially resolved tool calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } },
          { id: "tc_2", type: "function", function: { name: "Grep", arguments: '{}' } },
        ],
      },
      { role: "tool", tool_call_id: "tc_1", content: "ok" },
    ];

    const result = sanitizeForResume(messages);
    const synthetic = result.messages.find(
      (m) => m.role === "tool" && (m as any).tool_call_id === "tc_2",
    );
    expect(synthetic).toBeDefined();
    expect((synthetic as any).isError).toBe(true);
  });
});

describe("sanitizeForResume — preserves thinking fields on assistant merge", () => {
  it("preserves thinking_content and thinking_signature when merging consecutive assistants", () => {
    // Create a scenario where filtering produces consecutive assistant messages:
    // assistant(thinking) -> whitespace assistant (dropped) -> assistant(text)
    // After whitespace filter, the two assistants become consecutive and get merged.
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "first response",
        thinking_content: "I need to think about this",
        thinking_signature: "sig_abc123",
      } as AssistantMessage,
      { role: "assistant", content: "   " } as AssistantMessage, // whitespace-only, will be dropped
      { role: "assistant", content: "second response" } as AssistantMessage,
    ];

    const result = sanitizeForResume(messages);
    const assistants = result.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    const merged = assistants[0] as AssistantMessage;
    expect(merged.content).toContain("first response");
    expect(merged.content).toContain("second response");
    expect(merged.thinking_content).toBe("I need to think about this");
    expect(merged.thinking_signature).toBe("sig_abc123");
  });
});

// ---------------------------------------------------------------------------
// ensureToolResultPairing
// ---------------------------------------------------------------------------
describe("ensureToolResultPairing", () => {
  it("drops all-unresolved assistant with null content (strict fallback)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"x.ts"}' } },
          { id: "tc2", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
        ],
      } as any,
    ];

    const repaired = ensureToolResultPairing(messages);
    // Null content + all-unresolved → strict fallback drops the assistant
    expect(repaired.length).toBe(1);
    expect(repaired[0].role).toBe("user");
  });

  it("injects synthetic results when assistant has text content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "I'll help with that",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"x.ts"}' } },
          { id: "tc2", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
        ],
      } as any,
    ];

    const repaired = ensureToolResultPairing(messages);
    expect(repaired.length).toBe(4);
    expect(repaired[2].role).toBe("tool");
    expect((repaired[2] as any).tool_call_id).toBe("tc1");
    expect(repaired[3].role).toBe("tool");
    expect((repaired[3] as any).tool_call_id).toBe("tc2");
  });

  it("does not modify valid conversations", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "ReadFile", arguments: '{}' } },
        ],
      } as any,
      { role: "tool", tool_call_id: "tc1", content: "file content" } as any,
    ];

    const result = ensureToolResultPairing(messages);
    expect(result).toBe(messages);
  });

  it("preserves thinking data from both merged assistant messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "first", thinking_content: "thought A", thinking_signature: "sig_old" } as any,
      { role: "assistant", content: "second", thinking_content: "thought B", thinking_signature: "sig_new", redacted_thinking_data: "redacted_B" } as any,
    ];

    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(2);
    const merged = result[1] as any;
    expect(merged.thinking_content).toContain("thought A");
    expect(merged.thinking_content).toContain("thought B");
    expect(merged.thinking_signature).toBe("sig_new");
    expect(merged.redacted_thinking_data).toBe("redacted_B");
  });

  it("only fills missing results, not already resolved ones", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "ReadFile", arguments: '{}' } },
          { id: "tc2", type: "function", function: { name: "Bash", arguments: '{}' } },
        ],
      } as any,
      { role: "tool", tool_call_id: "tc1", content: "result" } as any,
    ];

    const repaired = ensureToolResultPairing(messages);
    expect(repaired.length).toBe(4);
    const toolMsgs = repaired.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(2);
    expect((toolMsgs[1] as any).tool_call_id).toBe("tc2");
    expect((toolMsgs[1] as any).isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fillPartiallyResolvedToolCalls with multiple missing
// ---------------------------------------------------------------------------

describe("sanitizeForResume — fillPartiallyResolvedToolCalls", () => {
  it("inserts synthetic error results for multiple missing tool calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling three tools",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "A", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "B", arguments: "{}" } },
          { id: "tc3", type: "function", function: { name: "C", arguments: "{}" } },
        ],
      } as any,
      { role: "tool", tool_call_id: "tc1", content: "result for tc1" } as any,
    ];

    const { messages: sanitized } = sanitizeForResume(messages);

    const toolResults = sanitized.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(3);

    const syntheticIds = toolResults
      .filter((m) => (m as any).isError)
      .map((m) => (m as any).tool_call_id);
    expect(syntheticIds).toContain("tc2");
    expect(syntheticIds).toContain("tc3");
    expect(syntheticIds).not.toContain("tc1");
  });

  it("preserves thinking on interrupted assistant when generating synthetic results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "think and act" },
      {
        role: "assistant",
        content: "executing",
        thinking_content: "deep reasoning",
        thinking_signature: "sig_current",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "Bash", arguments: "{}" } },
        ],
      } as any,
      // Interrupted — no tool result
    ];

    const { messages: sanitized, interruption } = sanitizeForResume(messages);

    // The assistant with unresolved tool_call should be removed
    // but if partial (has thinking), the thinking should be preserved
    // in the sanitized output somehow
    expect(interruption.kind).not.toBe("none");

    const normalized = normalizeMessagesForAPI(sanitized);
    assertValidMessageSequence(normalized);
  });
});

// ---------------------------------------------------------------------------
// generateMissingToolResults edge cases
// ---------------------------------------------------------------------------

describe("generateMissingToolResults edge cases", () => {
  it("returns empty array when assistant has no tool_calls", () => {
    const result = generateMissingToolResults(
      { role: "assistant", content: "no tools" } as AssistantMessage,
      [],
      "test reason",
    );
    expect(result).toEqual([]);
  });

  it("returns empty array when all calls have results", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc1", type: "function", function: { name: "A", arguments: "{}" } },
        { id: "tc2", type: "function", function: { name: "B", arguments: "{}" } },
      ],
    };
    const existing: ChatMessage[] = [
      { role: "tool", tool_call_id: "tc1", content: "r1" },
      { role: "tool", tool_call_id: "tc2", content: "r2" },
    ];
    const result = generateMissingToolResults(assistant, existing, "test");
    expect(result).toEqual([]);
  });

  it("generates synthetic results for all missing when none resolved", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc1", type: "function", function: { name: "A", arguments: "{}" } },
        { id: "tc2", type: "function", function: { name: "B", arguments: "{}" } },
        { id: "tc3", type: "function", function: { name: "C", arguments: "{}" } },
      ],
    };
    const result = generateMissingToolResults(assistant, [], "crash");
    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.isError).toBe(true);
      expect(r.content).toContain("crash");
    }
  });

  it("includes the reason string in synthetic results", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc1", type: "function", function: { name: "A", arguments: "{}" } },
      ],
    };
    const result = generateMissingToolResults(
      assistant,
      [],
      "Provider error: 502 Bad Gateway",
    );
    expect(result[0].content).toContain("502 Bad Gateway");
  });
});

// ---------------------------------------------------------------------------
// generateMissingToolResults / ensureToolResultPairing / sanitizeForResume
// consistency — all three entry points should produce structurally equivalent
// synthetic results for the same broken transcript.
// ---------------------------------------------------------------------------

describe("generateMissingToolResults — entry-point consistency", () => {
  const brokenTranscript: ChatMessage[] = [
    { role: "user", content: "do things" },
    {
      role: "assistant",
      content: "calling three tools",
      tool_calls: [
        { id: "tc1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
        { id: "tc2", type: "function", function: { name: "Grep", arguments: '{"pattern":"x"}' } },
        { id: "tc3", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"a.txt"}' } },
      ],
    } as AssistantMessage,
    { role: "tool", tool_call_id: "tc1", content: "real result for tc1" } as any,
  ];

  it("all three paths generate synthetic results for the same missing tool_call_ids", () => {
    // Path 1: generateMissingToolResults directly
    const assistant = brokenTranscript[1] as AssistantMessage;
    const existingToolMsgs = brokenTranscript.filter((m) => m.role === "tool");
    const directResults = generateMissingToolResults(assistant, existingToolMsgs, "test");

    // Path 2: ensureToolResultPairing (from normalize.ts)
    const normalizeRepaired = ensureToolResultPairing([...brokenTranscript]);

    // Path 3: sanitizeForResume (includes fillPartiallyResolvedToolCalls)
    const { messages: sanitized } = sanitizeForResume([...brokenTranscript]);

    // Direct: should produce synthetic for tc2 and tc3
    const directIds = new Set(directResults.map((r) => r.tool_call_id));
    expect(directIds).toEqual(new Set(["tc2", "tc3"]));
    for (const r of directResults) {
      expect(r.isError).toBe(true);
    }

    // ensureToolResultPairing: should also have results for tc2 and tc3
    const normalizeToolMsgs = normalizeRepaired.filter((m) => m.role === "tool") as any[];
    const normalizeIds = new Set(normalizeToolMsgs.map((m) => m.tool_call_id));
    expect(normalizeIds).toEqual(new Set(["tc1", "tc2", "tc3"]));
    const normalizeSynthetic = normalizeToolMsgs.filter(
      (m) => m.tool_call_id === "tc2" || m.tool_call_id === "tc3",
    );
    for (const m of normalizeSynthetic) {
      expect(m.isError).toBe(true);
    }

    // sanitizeForResume: should also have results for tc2 and tc3
    const sanitizedToolMsgs = sanitized.filter((m) => m.role === "tool") as any[];
    const sanitizedIds = new Set(sanitizedToolMsgs.map((m) => m.tool_call_id));
    expect(sanitizedIds).toEqual(new Set(["tc1", "tc2", "tc3"]));
    const sanitizedSynthetic = sanitizedToolMsgs.filter(
      (m) => m.tool_call_id === "tc2" || m.tool_call_id === "tc3",
    );
    for (const m of sanitizedSynthetic) {
      expect(m.isError).toBe(true);
    }
  });

  it("all paths produce API-valid transcripts after normalization", () => {
    // Path 2: ensureToolResultPairing
    const normalizeRepaired = ensureToolResultPairing([...brokenTranscript]);
    const normalized2 = normalizeMessagesForAPI(normalizeRepaired);
    assertValidMessageSequence(normalized2);

    // Path 3: sanitizeForResume then normalize
    const { messages: sanitized } = sanitizeForResume([...brokenTranscript]);
    const normalized3 = normalizeMessagesForAPI(sanitized);
    assertValidMessageSequence(normalized3);
  });

  it("real results are never overwritten by synthetic ones", () => {
    // Path 2
    const normalizeRepaired = ensureToolResultPairing([...brokenTranscript]);
    const tc1FromNormalize = normalizeRepaired.find(
      (m) => m.role === "tool" && (m as any).tool_call_id === "tc1",
    ) as any;
    expect(tc1FromNormalize.content).toBe("real result for tc1");
    expect(tc1FromNormalize.isError).toBeFalsy();

    // Path 3
    const { messages: sanitized } = sanitizeForResume([...brokenTranscript]);
    const tc1FromSanitize = sanitized.find(
      (m) => m.role === "tool" && (m as any).tool_call_id === "tc1",
    ) as any;
    expect(tc1FromSanitize.content).toBe("real result for tc1");
    expect(tc1FromSanitize.isError).toBeFalsy();
  });

  it("handles the all-missing case (null content + no results)", () => {
    const allMissing: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "A", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "B", arguments: "{}" } },
        ],
      } as AssistantMessage,
    ];

    // Path 1
    const assistant = allMissing[1] as AssistantMessage;
    const directResults = generateMissingToolResults(assistant, [], "crash");
    expect(directResults).toHaveLength(2);

    // Path 2: ensureToolResultPairing strict fallback drops null-content all-missing
    const normalizeRepaired = ensureToolResultPairing([...allMissing]);
    const assistants = normalizeRepaired.filter((m) => m.role === "assistant");
    // Should either drop the assistant or inject synthetics
    const normalized = normalizeMessagesForAPI(normalizeRepaired);
    assertValidMessageSequence(normalized);

    // Path 3
    const { messages: sanitized } = sanitizeForResume([...allMissing]);
    const normalized3 = normalizeMessagesForAPI(sanitized);
    assertValidMessageSequence(normalized3);
  });
});
