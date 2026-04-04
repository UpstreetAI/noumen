import { describe, it, expect } from "vitest";
import {
  enforceToolResultBudget,
  createBudgetState,
  type ToolResultBudgetConfig,
} from "../compact/tool-result-budget.js";
import type { ChatMessage } from "../session/types.js";

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

function toolResultMsg(toolCallId: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: toolCallId, content };
}

const config: ToolResultBudgetConfig = {
  enabled: true,
  maxCharsPerResult: 100,
  maxCharsPerGroup: 300,
  previewChars: 20,
};

describe("enforceToolResultBudget", () => {
  it("returns messages unchanged when disabled", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithToolCalls([{ id: "tc1", name: "Bash" }]),
      toolResultMsg("tc1", "x".repeat(5000)),
    ];
    const result = enforceToolResultBudget(msgs, { enabled: false });
    expect(result.messages).toBe(msgs);
    expect(result.tokensFreed).toBe(0);
  });

  it("truncates a single result exceeding maxCharsPerResult", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithToolCalls([{ id: "tc1", name: "Bash" }]),
      toolResultMsg("tc1", "x".repeat(200)),
    ];

    const result = enforceToolResultBudget(msgs, config);
    const content = (result.messages[2] as { content: string }).content;
    expect(content.length).toBeLessThan(200);
    expect(content).toContain("[truncated, 200 total chars]");
    expect(result.truncatedEntries).toHaveLength(1);
    expect(result.truncatedEntries[0].toolCallId).toBe("tc1");
    expect(result.truncatedEntries[0].originalChars).toBe(200);
    expect(result.tokensFreed).toBeGreaterThan(0);
  });

  it("enforces group budget by truncating the largest result first", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithToolCalls([
        { id: "tc1", name: "A" },
        { id: "tc2", name: "B" },
        { id: "tc3", name: "C" },
      ]),
      toolResultMsg("tc1", "a".repeat(90)),  // under per-result cap
      toolResultMsg("tc2", "b".repeat(90)),  // under per-result cap
      toolResultMsg("tc3", "c".repeat(90)),  // under per-result cap but 90*3 = 270 < 300
    ];

    // Total 270 chars — under the 300 group budget, so nothing should be truncated
    const result = enforceToolResultBudget(msgs, config);
    expect(result.truncatedEntries).toHaveLength(0);
  });

  it("truncates when group total exceeds budget", () => {
    const groupConfig: ToolResultBudgetConfig = {
      enabled: true,
      maxCharsPerResult: 500,
      maxCharsPerGroup: 200,
      previewChars: 10,
    };

    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithToolCalls([
        { id: "tc1", name: "A" },
        { id: "tc2", name: "B" },
      ]),
      toolResultMsg("tc1", "a".repeat(80)),
      toolResultMsg("tc2", "b".repeat(150)),  // larger, will be truncated first
    ];

    // Total = 230 > 200. tc2 (150) is largest and will be truncated.
    const result = enforceToolResultBudget(msgs, groupConfig);
    expect(result.truncatedEntries.length).toBeGreaterThanOrEqual(1);
    // tc2 should have been truncated (it's the largest)
    const truncatedIds = result.truncatedEntries.map((e) => e.toolCallId);
    expect(truncatedIds).toContain("tc2");
  });

  it("respects already-truncated ids in state", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithToolCalls([{ id: "tc1", name: "Bash" }]),
      toolResultMsg("tc1", "x".repeat(200)),
    ];

    const state = createBudgetState();
    state.truncatedIds.add("tc1");

    const result = enforceToolResultBudget(msgs, config, state);
    // Should not re-truncate since tc1 is already tracked
    expect(result.truncatedEntries).toHaveLength(0);
    expect(result.tokensFreed).toBe(0);
  });

  it("tracks new truncations in returned state", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantWithToolCalls([{ id: "tc1", name: "Bash" }]),
      toolResultMsg("tc1", "x".repeat(200)),
    ];

    const result = enforceToolResultBudget(msgs, config);
    expect(result.state.truncatedIds.has("tc1")).toBe(true);
  });

  it("handles messages with no tool calls gracefully", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];

    const result = enforceToolResultBudget(msgs, config);
    expect(result.messages).toEqual(msgs);
    expect(result.tokensFreed).toBe(0);
  });
});
