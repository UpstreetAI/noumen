import { describe, it, expect, beforeEach } from "vitest";
import { MockFs, MockAIProvider, textResponse } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import { adjustSplitForToolPairs, compactConversation } from "../compact/compact.js";
import {
  createAutoCompactConfig,
  shouldAutoCompact,
} from "../compact/auto-compact.js";
import type { ChatMessage } from "../session/types.js";

let fs: MockFs;
let storage: SessionStorage;
let provider: MockAIProvider;

beforeEach(() => {
  fs = new MockFs();
  storage = new SessionStorage(fs, "/sessions");
  provider = new MockAIProvider();
});

describe("compactConversation", () => {
  it("summarizes messages and persists boundary + summary", async () => {
    provider.addResponse(textResponse("This is the summary."));

    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];

    const result = await compactConversation(
      provider,
      "mock-model",
      messages,
      storage,
      "s1",
    );

    // Returns a single summary message
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("[Conversation Summary]");
    expect(result[0].content).toContain("This is the summary.");

    // Verify it was persisted (boundary then summary; crash safety: an
    // orphaned boundary with no summary after it falls back to the prior boundary)
    const entries = await storage.loadAllEntries("s1");
    const types = entries.map((e) => e.type);
    expect(types).toContain("compact-boundary");
    expect(types).toContain("summary");
    expect(types.indexOf("compact-boundary")).toBeLessThan(types.indexOf("summary"));

    // AI was called with the messages + summary prompt
    expect(provider.calls).toHaveLength(1);
    const sentMessages = provider.calls[0].messages;
    expect(sentMessages).toHaveLength(3); // original 2 + summarization prompt
  });

  it("uses custom instructions when provided", async () => {
    provider.addResponse(textResponse("Custom summary."));

    await compactConversation(
      provider,
      "mock-model",
      [{ role: "user", content: "x" }],
      storage,
      "s1",
      { customInstructions: "Summarize briefly." },
    );

    const lastMsg =
      provider.calls[0].messages[provider.calls[0].messages.length - 1];
    expect(lastMsg.content).toBe("Summarize briefly.");
  });
});

describe("compactConversation write ordering", () => {
  it("writes compact-boundary then summary (boundary before summary)", async () => {
    provider.addResponse(textResponse("Summary text."));

    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    await compactConversation(provider, "mock-model", messages, storage, "s1");

    const entries = await storage.loadAllEntries("s1");
    const types = entries.map((e) => e.type);
    const boundaryIdx = types.indexOf("compact-boundary");
    const summaryIdx = types.indexOf("summary");

    expect(boundaryIdx).not.toBe(-1);
    expect(summaryIdx).not.toBe(-1);
    // Boundary comes first, then summary
    expect(boundaryIdx).toBeLessThan(summaryIdx);
  });
});

describe("compactConversation merges consecutive same-role after summary", () => {
  it("merges summary (user) with user-role tail message", async () => {
    provider.addResponse(textResponse("Summary."));

    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
      { role: "assistant", content: "reply2" },
      { role: "user", content: "tail user message" },
    ];

    const result = await compactConversation(
      provider, "mock-model", messages, storage, "s1",
      { tailMessagesToKeep: 1 },
    );

    // Summary (user) + tail user message should be merged into one
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    const content = typeof userMsgs[0].content === "string"
      ? userMsgs[0].content : "";
    expect(content).toContain("[Conversation Summary]");
    expect(content).toContain("tail user message");
  });
});

describe("createAutoCompactConfig", () => {
  it("returns defaults", () => {
    const config = createAutoCompactConfig();
    expect(config.enabled).toBe(true);
    expect(config.threshold).toBe(100_000);
  });

  it("respects overrides", () => {
    const config = createAutoCompactConfig({
      enabled: false,
      threshold: 50_000,
    });
    expect(config.enabled).toBe(false);
    expect(config.threshold).toBe(50_000);
  });
});

describe("shouldAutoCompact", () => {
  it("returns false below threshold", () => {
    const config = createAutoCompactConfig({ threshold: 1000 });
    const messages: ChatMessage[] = [{ role: "user", content: "short" }];
    expect(shouldAutoCompact(messages, config)).toBe(false);
  });

  it("returns true at or above threshold", () => {
    const config = createAutoCompactConfig({ threshold: 10 });
    // "x".repeat(100) = 100 chars ≈ 25 tokens + 4 overhead = 29 > 10
    const messages: ChatMessage[] = [
      { role: "user", content: "x".repeat(100) },
    ];
    expect(shouldAutoCompact(messages, config)).toBe(true);
  });

  it("returns false when disabled", () => {
    const config = createAutoCompactConfig({ enabled: false, threshold: 1 });
    const messages: ChatMessage[] = [
      { role: "user", content: "x".repeat(1000) },
    ];
    expect(shouldAutoCompact(messages, config)).toBe(false);
  });
});

describe("adjustSplitForToolPairs", () => {
  it("moves split point before assistant when it would land on tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } },
        ],
      },
      { role: "tool", tool_call_id: "tc_1", content: "result" },
      { role: "user", content: "next" },
    ];

    // splitIdx=2 lands on tool result — should adjust to 1 (before assistant)
    const adjusted = adjustSplitForToolPairs(messages, 2);
    expect(adjusted).toBe(1);
  });

  it("leaves split unchanged when not on a tool result", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "next" },
    ];

    const adjusted = adjustSplitForToolPairs(messages, 2);
    expect(adjusted).toBe(2);
  });

  it("handles split at start of array", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
    ];
    expect(adjustSplitForToolPairs(messages, 0)).toBe(0);
  });

  it("handles split at end of array", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(adjustSplitForToolPairs(messages, 2)).toBe(2);
  });

  it("moves past multiple consecutive tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do both" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc_1", type: "function", function: { name: "Bash", arguments: '{}' } },
          { id: "tc_2", type: "function", function: { name: "Grep", arguments: '{}' } },
        ],
      },
      { role: "tool", tool_call_id: "tc_1", content: "r1" },
      { role: "tool", tool_call_id: "tc_2", content: "r2" },
      { role: "user", content: "next" },
    ];

    // splitIdx=3 lands on second tool result
    const adjusted = adjustSplitForToolPairs(messages, 3);
    expect(adjusted).toBe(1);
  });
});

describe("compactConversation preserves thinking fields on merge", () => {
  it("preserves thinking_content when summary merges with assistant tail", async () => {
    provider.addResponse(textResponse("Summary."));

    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
      {
        role: "assistant",
        content: "thinking reply",
        thinking_content: "deep thoughts",
        thinking_signature: "sig_xyz",
      } as any,
    ];

    // tailMessagesToKeep: 1 keeps only the last assistant
    // summary (user) + assistant tail — no merge needed for assistants here
    // but verify the assistant's thinking fields survive
    const result = await compactConversation(
      provider, "mock-model", messages, storage, "s1",
      { tailMessagesToKeep: 1 },
    );

    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as any).thinking_content).toBe("deep thoughts");
    expect((assistants[0] as any).thinking_signature).toBe("sig_xyz");
  });
});
