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

// ---------------------------------------------------------------------------
// reorderToolResultsAfterAssistant
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI — reorderToolResultsAfterAssistant", () => {
  it("moves displaced tool results back after their owning assistant", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling tool",
        tool_calls: [{ id: "tc1", type: "function", function: { name: "Bash", arguments: "{}" } }],
      } as AssistantMessage,
      { role: "user", content: "interruption wedged between assistant and result" },
      { role: "tool", tool_call_id: "tc1", content: "tool output" } as ToolResultMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);

    const asstIdx = result.findIndex((m) => m.role === "assistant");
    const toolIdx = result.findIndex((m) => m.role === "tool");
    expect(toolIdx).toBe(asstIdx + 1);
  });

  it("reorders multiple displaced tool results from different assistants", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "first call",
        tool_calls: [{ id: "tc1", type: "function", function: { name: "A", arguments: "{}" } }],
      } as AssistantMessage,
      { role: "user", content: "wedge 1" },
      {
        role: "assistant",
        content: "second call",
        tool_calls: [{ id: "tc2", type: "function", function: { name: "B", arguments: "{}" } }],
      } as AssistantMessage,
      { role: "user", content: "wedge 2" },
      { role: "tool", tool_call_id: "tc1", content: "result1" } as ToolResultMessage,
      { role: "tool", tool_call_id: "tc2", content: "result2" } as ToolResultMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);

    const idempotent = normalizeMessagesForAPI(result);
    expect(idempotent).toEqual(result);
  });

  it("handles assistant with multiple tool_calls and all results displaced", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "multi-tool",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "A", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "B", arguments: "{}" } },
        ],
      } as AssistantMessage,
      { role: "user", content: "interruption" },
      { role: "tool", tool_call_id: "tc1", content: "r1" } as ToolResultMessage,
      { role: "tool", tool_call_id: "tc2", content: "r2" } as ToolResultMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);

    const asstIdx = result.findIndex((m) => m.role === "assistant");
    expect(result[asstIdx + 1]?.role).toBe("tool");
    expect(result[asstIdx + 2]?.role).toBe("tool");
  });
});

// ---------------------------------------------------------------------------
// validateImagesForAPI
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI — validateImagesForAPI", () => {
  it("caps images at 20 per request", () => {
    const imageParts: ContentPart[] = [];
    for (let i = 0; i < 25; i++) {
      imageParts.push({
        type: "image",
        data: `base64data${i}`,
        media_type: "image/png",
      } as ContentPart);
    }
    const messages: ChatMessage[] = [
      { role: "user", content: imageParts },
      { role: "assistant", content: "ok" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);

    const userMsg = result[0];
    const content = userMsg.content as ContentPart[];
    expect(Array.isArray(content)).toBe(true);

    const imageCount = content.filter((p) => p.type === "image").length;
    expect(imageCount).toBeLessThanOrEqual(20);

    const placeholders = content.filter(
      (p) => p.type === "text" && (p as { text: string }).text.includes("too many images"),
    );
    expect(placeholders.length).toBe(5);
  });

  it("replaces oversized base64 images with placeholder", () => {
    const bigData = "x".repeat(6 * 1024 * 1024); // 6MB
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "check this" },
          { type: "image", data: bigData, media_type: "image/png" } as ContentPart,
        ],
      },
      { role: "assistant", content: "ok" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);

    const userContent = result[0].content as ContentPart[];
    const placeholder = userContent.find(
      (p) => p.type === "text" && (p as { text: string }).text.includes("size limit"),
    );
    expect(placeholder).toBeDefined();
    expect(userContent.filter((p) => p.type === "image").length).toBe(0);
  });

  it("replaces images with unsupported media_type", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", data: "abc", media_type: "image/bmp" } as ContentPart,
        ],
      },
      { role: "assistant", content: "ok" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);

    const userContent = result[0].content as ContentPart[];
    const placeholder = userContent.find(
      (p) => p.type === "text" && (p as { text: string }).text.includes("unsupported format"),
    );
    expect(placeholder).toBeDefined();
  });

  it("allows valid images through unchanged", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "analyze" },
          { type: "image", data: "smalldata", media_type: "image/jpeg" } as ContentPart,
        ],
      },
      { role: "assistant", content: "ok" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    const userContent = result[0].content as ContentPart[];
    expect(userContent.filter((p) => p.type === "image").length).toBe(1);
  });

  it("does not touch images in assistant messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "here is an image" },
          { type: "image", data: "x".repeat(6 * 1024 * 1024), media_type: "image/bmp" },
        ],
      } as unknown as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    const asstContent = (result.find((m) => m.role === "assistant") as AssistantMessage).content;
    if (Array.isArray(asstContent)) {
      expect(asstContent.some((p) => (p as ContentPart).type === "image")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// stripStaleSignatureBlocks
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI — stripStaleSignatureBlocks", () => {
  it("strips thinking_signature from non-final assistants", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "thought 1",
        thinking_content: "deep",
        thinking_signature: "sig-old",
      } as AssistantMessage,
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: "thought 2",
        thinking_content: "deeper",
        thinking_signature: "sig-current",
      } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);

    const assistants = result.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants[0].thinking_signature).toBeUndefined();
    expect(assistants[1].thinking_signature).toBe("sig-current");
  });

  it("strips redacted_thinking_data from non-final assistants", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "first",
        redacted_thinking_data: "redacted-old",
      } as AssistantMessage,
      { role: "user", content: "next" },
      {
        role: "assistant",
        content: "second",
        redacted_thinking_data: "redacted-current",
      } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);

    const assistants = result.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants[0].redacted_thinking_data).toBeUndefined();
    expect(assistants[1].redacted_thinking_data).toBe("redacted-current");
  });

  it("no-ops when only one assistant exists", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "only one",
        thinking_signature: "sig",
        redacted_thinking_data: "data",
      } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    const asst = result.find((m) => m.role === "assistant") as AssistantMessage;
    expect(asst.thinking_signature).toBe("sig");
    expect(asst.redacted_thinking_data).toBe("data");
  });
});
