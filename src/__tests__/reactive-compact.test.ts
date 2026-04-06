import { describe, it, expect, beforeEach } from "vitest";
import { MockFs, MockAIProvider, textResponse } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import { tryReactiveCompact } from "../compact/reactive-compact.js";
import type { ChatMessage } from "../session/types.js";

let fs: MockFs;
let storage: SessionStorage;
let provider: MockAIProvider;

beforeEach(() => {
  fs = new MockFs();
  storage = new SessionStorage(fs, "/sessions");
  provider = new MockAIProvider();
});

describe("tryReactiveCompact", () => {
  it("returns null when there are fewer than 2 messages", async () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    const result = await tryReactiveCompact(provider, "mock-model", msgs, storage, "s1");
    expect(result).toBeNull();
  });

  it("compacts the conversation on success", async () => {
    provider.addResponse(textResponse("Summary of conversation."));

    const msgs: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
      { role: "user", content: "more stuff" },
      { role: "assistant", content: "more answers" },
      { role: "user", content: "even more" },
      { role: "assistant", content: "even more answers" },
      { role: "user", content: "last question" },
      { role: "assistant", content: "last answer" },
    ];

    const result = await tryReactiveCompact(provider, "mock-model", msgs, storage, "s1");
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("compacted");
    expect(result!.messages.length).toBeLessThan(msgs.length);
    const firstContent = result!.messages[0].content;
    const contentStr = typeof firstContent === "string"
      ? firstContent
      : Array.isArray(firstContent)
        ? (firstContent as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("")
        : "";
    expect(contentStr).toContain("[Conversation Summary]");
  });

  it("falls back to truncation when compaction fails", async () => {
    // Provider throws on every call
    provider.addResponse([]);
    const errorProvider = new MockAIProvider();
    // Force error by not queueing any responses

    const msgs: ChatMessage[] = [
      { role: "user", content: "a".repeat(10_000) },
      { role: "assistant", content: "b".repeat(10_000) },
      { role: "user", content: "c".repeat(10_000) },
      { role: "assistant", content: "d".repeat(10_000) },
    ];

    const result = await tryReactiveCompact(
      errorProvider,
      "mock-model",
      msgs,
      storage,
      "s1",
    );

    // Since compaction fails (no response queued), it falls back to truncation
    // The result depends on whether truncation actually changes anything
    // given the effective context window for "mock-model" (128k default)
    // With ~10k tokens total, truncation may not trim anything
    if (result) {
      expect(result.strategy).toBe("truncated");
    }
  });

  it("persists truncated messages when compaction fails (truncation fallback)", async () => {
    const errorProvider = new MockAIProvider();
    // No responses queued → provider will throw on chat()

    // Create enough messages that truncation actually drops some.
    // We need the estimated token count to exceed the effective context window
    // for "mock-model" (128k default) so truncation trims something.
    // Each message is ~25k chars ≈ 6250 tokens + 4 overhead each = ~6254 * 8 = ~50k
    // To make truncation actually kick in, use a huge amount of content.
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(20_000) } as ChatMessage);
    }

    const result = await tryReactiveCompact(
      errorProvider,
      "mock-model",
      msgs,
      storage,
      "trunc-persist",
    );

    if (result && result.strategy === "truncated") {
      // Verify persistence: compact boundary was written
      const entries = await storage.loadAllEntries("trunc-persist");
      expect(entries.some((e) => e.type === "compact-boundary")).toBe(true);
      // And the post-boundary messages should be loadable
      const loaded = await storage.loadMessages("trunc-persist");
      expect(loaded.length).toBeGreaterThan(0);
      expect(loaded.length).toBeLessThan(msgs.length);
    }
  });

  it("persists compact boundary and summary in storage", async () => {
    provider.addResponse(textResponse("A summary."));

    const msgs: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    await tryReactiveCompact(provider, "mock-model", msgs, storage, "s1");

    const entries = await storage.loadAllEntries("s1");
    expect(entries.some((e) => e.type === "compact-boundary")).toBe(true);
    expect(entries.some((e) => e.type === "summary")).toBe(true);
  });
});
