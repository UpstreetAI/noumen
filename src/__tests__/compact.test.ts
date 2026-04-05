import { describe, it, expect, beforeEach } from "vitest";
import { MockFs, MockAIProvider, textResponse } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import { compactConversation } from "../compact/compact.js";
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

    // Verify it was persisted (summary before boundary for crash safety:
    // an orphaned boundary with no summary after it falls back to the prior boundary)
    const entries = await storage.loadAllEntries("s1");
    expect(entries.map((e) => e.type)).toEqual([
      "summary",
      "compact-boundary",
    ]);

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
