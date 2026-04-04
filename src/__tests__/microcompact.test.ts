import { describe, it, expect } from "vitest";
import {
  microcompactMessages,
  COMPACTABLE_TOOLS,
  CLEARED_PLACEHOLDER,
  type MicrocompactConfig,
} from "../compact/microcompact.js";
import type { ChatMessage } from "../session/types.js";

function toolResultMsg(toolCallId: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: toolCallId, content };
}

function assistantWithToolCalls(
  calls: Array<{ id: string; name: string }>,
): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: "{}" },
    })),
  };
}

const enabledConfig: MicrocompactConfig = { enabled: true, keepRecent: 2 };

describe("microcompactMessages", () => {
  it("returns messages unchanged when disabled", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      assistantWithToolCalls([{ id: "tc1", name: "Bash" }]),
      toolResultMsg("tc1", "x".repeat(10_000)),
    ];
    const result = microcompactMessages(msgs, { enabled: false });
    expect(result.messages).toBe(msgs);
    expect(result.tokensFreed).toBe(0);
  });

  it("clears old compactable tool results, keeping the most recent N", () => {
    const longContent = "x".repeat(1000);
    const msgs: ChatMessage[] = [
      { role: "user", content: "step 1" },
      assistantWithToolCalls([{ id: "tc1", name: "ReadFile" }]),
      toolResultMsg("tc1", longContent),
      { role: "user", content: "step 2" },
      assistantWithToolCalls([{ id: "tc2", name: "Bash" }]),
      toolResultMsg("tc2", longContent),
      { role: "user", content: "step 3" },
      assistantWithToolCalls([{ id: "tc3", name: "Grep" }]),
      toolResultMsg("tc3", "recent content C"),
      { role: "user", content: "step 4" },
      assistantWithToolCalls([{ id: "tc4", name: "Glob" }]),
      toolResultMsg("tc4", "recent content D"),
    ];

    const result = microcompactMessages(msgs, enabledConfig);

    // tc1 and tc2 should be cleared (oldest 2), tc3 and tc4 kept (keepRecent=2)
    expect((result.messages[2] as { content: string }).content).toBe(CLEARED_PLACEHOLDER);
    expect((result.messages[5] as { content: string }).content).toBe(CLEARED_PLACEHOLDER);
    expect((result.messages[8] as { content: string }).content).toBe("recent content C");
    expect((result.messages[11] as { content: string }).content).toBe("recent content D");
    expect(result.tokensFreed).toBeGreaterThan(0);
  });

  it("clears compactable tool results including Edit and Write", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithToolCalls([
        { id: "tc1", name: "EditFile" },
        { id: "tc2", name: "WriteFile" },
        { id: "tc3", name: "ReadFile" },
      ]),
      toolResultMsg("tc1", "edit result"),
      toolResultMsg("tc2", "write result"),
      toolResultMsg("tc3", "read result"),
    ];

    const result = microcompactMessages(msgs, { enabled: true, keepRecent: 0 });

    // All three are compactable
    expect((result.messages[2] as { content: string }).content).toBe(CLEARED_PLACEHOLDER);
    expect((result.messages[3] as { content: string }).content).toBe(CLEARED_PLACEHOLDER);
    expect((result.messages[4] as { content: string }).content).toBe(CLEARED_PLACEHOLDER);
  });

  it("does not clear already-cleared results", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithToolCalls([{ id: "tc1", name: "Bash" }]),
      toolResultMsg("tc1", CLEARED_PLACEHOLDER),
      assistantWithToolCalls([{ id: "tc2", name: "Bash" }]),
      toolResultMsg("tc2", "actual content"),
    ];

    const result = microcompactMessages(msgs, { enabled: true, keepRecent: 0 });

    expect((result.messages[2] as { content: string }).content).toBe(CLEARED_PLACEHOLDER);
    expect((result.messages[4] as { content: string }).content).toBe(CLEARED_PLACEHOLDER);
  });

  it("returns unchanged when fewer eligible results than keepRecent", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      assistantWithToolCalls([{ id: "tc1", name: "Bash" }]),
      toolResultMsg("tc1", "some output"),
    ];

    const result = microcompactMessages(msgs, { enabled: true, keepRecent: 5 });
    expect(result.messages).toBe(msgs);
    expect(result.tokensFreed).toBe(0);
  });

  it("exports the expected compactable tool set", () => {
    expect(COMPACTABLE_TOOLS).toContain("ReadFile");
    expect(COMPACTABLE_TOOLS).toContain("EditFile");
    expect(COMPACTABLE_TOOLS).toContain("WriteFile");
    expect(COMPACTABLE_TOOLS).toContain("Bash");
    expect(COMPACTABLE_TOOLS).toContain("Grep");
    expect(COMPACTABLE_TOOLS).toContain("Glob");
    expect(COMPACTABLE_TOOLS).toContain("WebFetch");
    expect(COMPACTABLE_TOOLS).toContain("WebSearch");
  });
});
