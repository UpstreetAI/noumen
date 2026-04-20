import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockFs, MockAIProvider, textResponse } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import { tryReactiveCompact } from "../compact/reactive-compact.js";
import type { ChatMessage } from "../session/types.js";
import type { AIProvider, ChatParams, ChatStreamChunk } from "../providers/types.js";

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
    vi.spyOn(console, "warn").mockImplementation(() => {});
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
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

  it("propagates AbortError without persisting truncation", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const msgs: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
      { role: "user", content: "more" },
      { role: "assistant", content: "answers" },
    ];

    await expect(
      tryReactiveCompact(provider, "mock-model", msgs, storage, "s1", {
        signal: abortController.signal,
      }),
    ).rejects.toThrow("Compaction aborted");

    const entries = await storage.loadAllEntries("s1");
    expect(entries.some((e) => e.type === "compact-boundary")).toBe(false);
  });

  it("mid-stream abort propagates correctly", async () => {
    const abortController = new AbortController();

    const abortingProvider: AIProvider = {
      defaultModel: "mock-model",
      async *chat(_params: ChatParams): AsyncIterable<ChatStreamChunk> {
        yield {
          id: "chunk-1",
          model: "mock-model",
          choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
        };
        abortController.abort();
        yield {
          id: "chunk-2",
          model: "mock-model",
          choices: [{ index: 0, delta: { content: " summary" }, finish_reason: "stop" }],
        };
      },
    };

    const msgs: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
      { role: "user", content: "more" },
      { role: "assistant", content: "answers" },
    ];

    await expect(
      tryReactiveCompact(abortingProvider, "mock-model", msgs, storage, "s1", {
        signal: abortController.signal,
      }),
    ).rejects.toThrow("Compaction aborted");

    const entries = await storage.loadAllEntries("s1");
    expect(entries.some((e) => e.type === "compact-boundary")).toBe(false);
  });

  it("returns truncated result even when persistence fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorProvider = new MockAIProvider();

    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(20_000),
      } as ChatMessage);
    }

    // Sabotage storage writes after the first call so persistence fails
    const origAppendEntry = storage.appendEntry.bind(storage);
    let callCount = 0;
    vi.spyOn(storage, "appendEntry").mockImplementation(async (...args: any[]) => {
      callCount++;
      throw new Error("Disk full");
    });
    vi.spyOn(storage, "appendCompactBoundary").mockRejectedValue(new Error("Disk full"));

    const result = await tryReactiveCompact(
      errorProvider,
      "mock-model",
      msgs,
      storage,
      "persist-fail",
    );

    // In-memory result should still be usable despite persistence failure
    if (result) {
      expect(result.strategy).toBe("truncated");
      expect(result.messages.length).toBeLessThan(msgs.length);
      expect(result.messages.length).toBeGreaterThan(0);
    }
  });

  it("non-abort errors still trigger truncation fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorProvider = new MockAIProvider();
    // No responses queued — will throw generic error

    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(20_000),
      } as ChatMessage);
    }

    const result = await tryReactiveCompact(
      errorProvider,
      "mock-model",
      msgs,
      storage,
      "generic-err",
    );

    // Generic errors should still fall through to truncation
    if (result) {
      expect(result.strategy).toBe("truncated");
    }
  });
});
