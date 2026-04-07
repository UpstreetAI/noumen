/**
 * Deterministic adversarial tests for normalizeMessagesForAPI and
 * sanitizeForResume. Each test constructs a specific message shape
 * identified in the claude-code comparison as a likely source of bugs.
 *
 * These complement the random fuzz tests in normalize-fuzz.test.ts by
 * targeting exact edge cases that have low probability of appearing
 * randomly.
 */

import { describe, it, expect } from "vitest";
import type {
  ChatMessage,
  AssistantMessage,
  ToolResultMessage,
  ToolCallContent,
} from "../session/types.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";
import { assertValidMessageSequence } from "../messages/invariants.js";
import { sanitizeForResume } from "../session/recovery.js";

function tc(id: string, name = "Bash"): ToolCallContent {
  return {
    id,
    type: "function",
    function: { name, arguments: '{"command":"ls"}' },
  };
}

function tool(callId: string, content = "ok", isError = false): ToolResultMessage {
  return { role: "tool", tool_call_id: callId, content, ...(isError ? { isError: true } : {}) };
}

function assertValid(result: ChatMessage[], label: string): void {
  try {
    assertValidMessageSequence(result);
  } catch (err) {
    expect.fail(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const second = normalizeMessagesForAPI(result);
  expect(second, `${label}: not idempotent`).toEqual(result);
}

// ===========================================================================
// 1A: Thinking / whitespace ordering interaction
// ===========================================================================

describe("1A: thinking/whitespace ordering", () => {
  it("whitespace content + thinking_content in non-trailing position is preserved", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "\n\n",
        thinking_content: "deep thought",
      } as AssistantMessage,
      { role: "user", content: "next" },
      { role: "assistant", content: "reply" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "whitespace+thinking non-trailing");

    const thinkingAsst = result.find(
      (m) => m.role === "assistant" && (m as AssistantMessage).thinking_content,
    ) as AssistantMessage | undefined;
    expect(thinkingAsst).toBeDefined();
    expect(thinkingAsst!.thinking_content).toBe("deep thought");
  });

  it("empty content + thinking_content at END is stripped", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        thinking_content: "trailing thought",
      } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "trailing thinking-only");

    const lastMsg = result[result.length - 1];
    if (lastMsg.role === "assistant") {
      const asst = lastMsg as AssistantMessage;
      expect(
        asst.thinking_content && !asst.tool_calls?.length && (asst.content as string).trim() === "",
      ).toBe(false);
    }
  });

  it("null content + thinking_content at END is stripped", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        thinking_content: "trailing thought",
      } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "null+thinking trailing");
  });

  it("two consecutive assistants: first thinking-only (null content), second text — merged correctly", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        thinking_content: "thought",
      } as AssistantMessage,
      { role: "assistant", content: "final answer" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "thinking-null + text merge");

    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants.length).toBeLessThanOrEqual(1);
  });

  it("whitespace content + thinking_content + empty tool_calls — survives pipeline", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "  ",
        thinking_content: "thought",
        tool_calls: [],
      } as unknown as AssistantMessage,
      { role: "user", content: "then" },
      { role: "assistant", content: "done" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "whitespace+thinking+empty-tool_calls");
  });

  it("content '\\n\\n' with thinking at END is stripped — invariants hold", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "middle" } as AssistantMessage,
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: "\n\n",
        thinking_content: "final thought",
        thinking_signature: "sig_1",
      } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "newlines+thinking+sig trailing");
  });
});

// ===========================================================================
// 1B: Duplicate tool_use IDs across non-adjacent assistants
// ===========================================================================

describe("1B: duplicate tool_use IDs across non-adjacent assistants", () => {
  it("second assistant's duplicate tool_call is stripped; result for second is orphaned and removed", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("t1", "ReadFile")] } as AssistantMessage,
      tool("t1", "file contents"),
      { role: "user", content: "now do it again" },
      { role: "assistant", content: null, tool_calls: [tc("t1", "WriteFile")] } as AssistantMessage,
      tool("t1", "wrote it"),
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "dup-tool-use-id");

    const toolUseIds = new Set<string>();
    for (const m of result) {
      if (m.role === "assistant" && (m as AssistantMessage).tool_calls) {
        for (const t of (m as AssistantMessage).tool_calls!) {
          expect(toolUseIds.has(t.id)).toBe(false);
          toolUseIds.add(t.id);
        }
      }
    }
  });

  it("duplicate ID where second assistant has text content — assistant kept but tool_call stripped", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("dup1")] } as AssistantMessage,
      tool("dup1"),
      { role: "user", content: "more" },
      { role: "assistant", content: "I have text too", tool_calls: [tc("dup1", "Grep")] } as AssistantMessage,
      tool("dup1", "second result"),
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "dup-id-with-text");

    const secondAsst = result.filter((m) => m.role === "assistant")[1];
    if (secondAsst) {
      const asst = secondAsst as AssistantMessage;
      if (asst.tool_calls) {
        for (const t of asst.tool_calls) {
          expect(t.id).not.toBe("dup1");
        }
      }
    }
  });
});

// ===========================================================================
// 1C: Tool results separated by non-user messages
// ===========================================================================

describe("1C: tool results separated by non-user messages", () => {
  it("assistant -> text-only assistant -> tool result: reorder gathers result after owning assistant", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("tc_sep")] } as AssistantMessage,
      { role: "assistant", content: "interleaved text" } as AssistantMessage,
      tool("tc_sep"),
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "tool-sep-by-assistant");
  });

  it("tool result displaced by user message is reordered", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: null, tool_calls: [tc("tc_disp")] } as AssistantMessage,
      { role: "user", content: "interruption" },
      tool("tc_disp", "late result"),
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "tool-displaced-by-user");

    const asstIdx = result.findIndex(
      (m) => m.role === "assistant" && (m as AssistantMessage).tool_calls?.some((t) => t.id === "tc_disp"),
    );
    if (asstIdx >= 0) {
      const nextNonTool = result.findIndex((m, i) => i > asstIdx && m.role !== "tool");
      const toolIdx = result.findIndex(
        (m) => m.role === "tool" && (m as ToolResultMessage).tool_call_id === "tc_disp",
      );
      if (toolIdx >= 0 && nextNonTool >= 0) {
        expect(toolIdx).toBeLessThan(nextNonTool);
      }
    }
  });
});

// ===========================================================================
// 1D: Merge creates new trailing thinking-only
// ===========================================================================

describe("1D: merge creates trailing thinking-only", () => {
  it("two assistants merged at end: whitespace text + thinking → stripped", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "  " } as AssistantMessage,
      { role: "assistant", content: null, thinking_content: "thought" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "merge-trailing-thinking");
  });

  it("two assistants merged at end: real text + thinking → kept", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "real content" } as AssistantMessage,
      { role: "assistant", content: null, thinking_content: "thought" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "merge-trailing-text+thinking");

    const last = result[result.length - 1];
    if (last.role === "assistant") {
      expect((last as AssistantMessage).content).toBeTruthy();
    }
  });

  it("three consecutive assistants merged: thinking + whitespace + thinking → stripped", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, thinking_content: "t1" } as AssistantMessage,
      { role: "assistant", content: "   " } as AssistantMessage,
      { role: "assistant", content: null, thinking_content: "t2" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "triple-merge-trailing-thinking");
  });
});

// ===========================================================================
// 1E: sanitizeForResume then normalizeMessagesForAPI composition
// ===========================================================================

describe("1E: sanitize→normalize composition on adversarial patterns", () => {
  it("whitespace + thinking non-trailing → survives composition", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "\n\n", thinking_content: "thought" } as AssistantMessage,
      { role: "user", content: "next" },
      { role: "assistant", content: "done" } as AssistantMessage,
    ];
    const { messages: sanitized } = sanitizeForResume(msgs);
    const result = normalizeMessagesForAPI(sanitized);
    assertValid(result, "sanitize+normalize whitespace+thinking");

    const second = normalizeMessagesForAPI(result);
    expect(second).toEqual(result);
  });

  it("duplicate tool_use IDs → composition is idempotent", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("d1")] } as AssistantMessage,
      tool("d1"),
      { role: "user", content: "again" },
      { role: "assistant", content: null, tool_calls: [tc("d1")] } as AssistantMessage,
      tool("d1", "second"),
    ];
    const { messages: sanitized } = sanitizeForResume(msgs);
    const result = normalizeMessagesForAPI(sanitized);
    assertValid(result, "sanitize+normalize dup-ids");

    const second = normalizeMessagesForAPI(result);
    expect(second).toEqual(result);
  });

  it("unresolved tool uses → sanitize fills, normalize validates", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "starting",
        tool_calls: [tc("unres1"), tc("unres2")],
      } as AssistantMessage,
      tool("unres1", "done"),
    ];
    const { messages: sanitized, removals } = sanitizeForResume(msgs);
    const result = normalizeMessagesForAPI(sanitized);
    assertValid(result, "sanitize+normalize unresolved");
  });

  it("all-unresolved assistant → sanitize drops, normalize validates", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("gone1"), tc("gone2")] } as AssistantMessage,
    ];
    const { messages: sanitized } = sanitizeForResume(msgs);
    const result = normalizeMessagesForAPI(sanitized);
    assertValid(result, "sanitize+normalize all-unresolved");
  });
});

// ===========================================================================
// 2A: Duplicate tool_result for same tool_use_id
// ===========================================================================

describe("2A: duplicate tool_results", () => {
  it("keeps only the first tool_result for a given tool_call_id", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("dup_r")] } as AssistantMessage,
      tool("dup_r", "first result"),
      tool("dup_r", "second result"),
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "dup-tool-result");

    const toolResults = result.filter(
      (m) => m.role === "tool" && (m as ToolResultMessage).tool_call_id === "dup_r",
    );
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as ToolResultMessage).content).toBe("first result");
  });

  it("three duplicate tool_results → only first kept", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("tri")] } as AssistantMessage,
      tool("tri", "a"),
      tool("tri", "b"),
      tool("tri", "c"),
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "triple-dup-result");

    const triResults = result.filter(
      (m) => m.role === "tool" && (m as ToolResultMessage).tool_call_id === "tri",
    );
    expect(triResults).toHaveLength(1);
    expect((triResults[0] as ToolResultMessage).content).toBe("a");
  });
});

// ===========================================================================
// 2B: Leading orphan tool results
// ===========================================================================

describe("2B: leading orphan tool results", () => {
  it("tool_result at start with no assistant → stripped", () => {
    const msgs: ChatMessage[] = [
      tool("orphan_lead", "result without assistant"),
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "leading-orphan");

    expect(result.every((m) => m.role !== "tool" || (m as ToolResultMessage).tool_call_id !== "orphan_lead")).toBe(true);
  });

  it("tool_result after user (no preceding assistant) → stripped", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      tool("orphan_mid", "stray result"),
      { role: "assistant", content: "reply" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "mid-orphan");
  });

  it("multiple leading orphans → all stripped", () => {
    const msgs: ChatMessage[] = [
      tool("o1", "a"),
      tool("o2", "b"),
      tool("o3", "c"),
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "multiple-leading-orphans");

    expect(result.filter((m) => m.role === "tool")).toHaveLength(0);
  });
});

// ===========================================================================
// 2C: tool_result for dropped assistant's tool_use
// ===========================================================================

describe("2C: ordering — dedup runs before pairing", () => {
  it("dedup strips tool_use before pairing inserts synthetics", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("x1")] } as AssistantMessage,
      tool("x1", "done"),
      { role: "user", content: "more" },
      { role: "assistant", content: null, tool_calls: [tc("x1", "Grep")] } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "dedup-before-pairing");
  });

  it("all-unresolved assistant dropped; its tool_result also dropped; later valid assistant survives", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("drop1")] } as AssistantMessage,
      { role: "user", content: "next" },
      { role: "assistant", content: null, tool_calls: [tc("keep1")] } as AssistantMessage,
      tool("keep1", "result"),
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "drop-unresolved-keep-resolved");

    const keptResults = result.filter(
      (m) => m.role === "tool" && (m as ToolResultMessage).tool_call_id === "keep1",
    );
    expect(keptResults).toHaveLength(1);
  });
});

// ===========================================================================
// 2D: Empty assistant after stripping all tool_uses via dedup
// ===========================================================================

describe("2D: empty assistant after dedup strips tool_calls", () => {
  it("assistant with null content and all tool_calls deduped → dropped", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("first")] } as AssistantMessage,
      tool("first"),
      { role: "user", content: "next" },
      { role: "assistant", content: null, tool_calls: [tc("first")] } as AssistantMessage,
      { role: "user", content: "final" },
      { role: "assistant", content: "done" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "empty-after-dedup");
  });

  it("assistant with text content survives even when all tool_calls deduped", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("surv")] } as AssistantMessage,
      tool("surv"),
      { role: "user", content: "next" },
      { role: "assistant", content: "I have text", tool_calls: [tc("surv")] } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "text-survives-dedup");

    const assistantsWithText = result.filter(
      (m) => m.role === "assistant" && (m as AssistantMessage).content === "I have text",
    );
    expect(assistantsWithText.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// Extra edge cases from claude-code comparison
// ===========================================================================

describe("extra edge cases", () => {
  it("error tool_result with multipart content is sanitized to text-only", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [tc("err1")] } as AssistantMessage,
      {
        role: "tool",
        tool_call_id: "err1",
        content: [
          { type: "text", text: "Error details" },
          { type: "image", data: "abc", media_type: "image/png" },
        ],
        isError: true,
      } as ToolResultMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "error-multipart-sanitized");

    const tr = result.find(
      (m) => m.role === "tool" && (m as ToolResultMessage).tool_call_id === "err1",
    ) as ToolResultMessage;
    expect(tr).toBeDefined();
    expect(typeof tr.content).toBe("string");
    expect(tr.content).toContain("Error details");
  });

  it("stale thinking_signature stripped from non-final assistants", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "first reply",
        thinking_content: "thought",
        thinking_signature: "stale_sig",
      } as AssistantMessage,
      { role: "user", content: "next" },
      {
        role: "assistant",
        content: "second reply",
        thinking_content: "more thought",
        thinking_signature: "current_sig",
      } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "stale-sig-strip");

    const assistants = result.filter((m) => m.role === "assistant") as AssistantMessage[];
    if (assistants.length >= 2) {
      expect(assistants[0].thinking_signature).toBeUndefined();
      expect(assistants[assistants.length - 1].thinking_signature).toBe("current_sig");
    }
  });

  it("_turnId fields are stripped from output", () => {
    const tcId = "turn_tc";
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [tc(tcId)],
        _turnId: "turn_1",
      } as AssistantMessage,
      tool(tcId),
      {
        role: "assistant",
        content: "continuation",
        _turnId: "turn_1",
      } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "turnId-strip");

    for (const m of result) {
      if (m.role === "assistant") {
        expect((m as AssistantMessage)._turnId).toBeUndefined();
      }
    }
  });

  it("system messages in the middle are dropped", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "system", content: "injected" },
      { role: "assistant", content: "reply" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(msgs);
    assertValid(result, "system-dropped");
    expect(result.every((m) => m.role !== "system")).toBe(true);
  });
});
