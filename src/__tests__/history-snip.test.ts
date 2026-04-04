import { describe, it, expect } from "vitest";
import {
  applySnipRemovals,
  snipMessagesByUuids,
  projectSnippedView,
} from "../compact/history-snip.js";
import type { Entry, ChatMessage, MessageEntry } from "../session/types.js";
import type { UUID } from "../utils/uuid.js";

function makeMessageEntry(
  uuid: string,
  parentUuid: string | null,
  role: "user" | "assistant",
  content: string,
): MessageEntry {
  return {
    type: "message",
    uuid: uuid as UUID,
    parentUuid: parentUuid as UUID | null,
    sessionId: "s1",
    timestamp: new Date().toISOString(),
    message: { role, content } as ChatMessage,
  };
}

describe("applySnipRemovals", () => {
  it("returns all messages when no snip boundaries exist", () => {
    const entries: Entry[] = [
      makeMessageEntry("a", null, "user", "hello"),
      makeMessageEntry("b", "a", "assistant", "hi there"),
      makeMessageEntry("c", "b", "user", "how are you"),
    ];

    const result = applySnipRemovals(entries);
    expect(result.messages).toHaveLength(3);
    expect(result.removedCount).toBe(0);
    expect(result.relinkedCount).toBe(0);
  });

  it("removes messages listed in snip boundary", () => {
    const entries: Entry[] = [
      makeMessageEntry("a", null, "user", "hello"),
      makeMessageEntry("b", "a", "assistant", "hi there"),
      makeMessageEntry("c", "b", "user", "how are you"),
      makeMessageEntry("d", "c", "assistant", "I am fine"),
      {
        type: "snip-boundary",
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        snipMetadata: { removedUuids: ["b", "c"] },
      },
    ];

    const result = applySnipRemovals(entries);
    expect(result.messages).toHaveLength(2);
    expect(result.removedCount).toBe(2);
    expect((result.messages[0] as { content: string }).content).toBe("hello");
    expect((result.messages[1] as { content: string }).content).toBe("I am fine");
  });

  it("relinks parent pointers across gaps", () => {
    const entries: Entry[] = [
      makeMessageEntry("a", null, "user", "hello"),
      makeMessageEntry("b", "a", "assistant", "hi"),
      makeMessageEntry("c", "b", "user", "question"),
      makeMessageEntry("d", "c", "assistant", "answer"),
      {
        type: "snip-boundary",
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        snipMetadata: { removedUuids: ["b", "c"] },
      },
    ];

    const result = applySnipRemovals(entries);
    expect(result.relinkedCount).toBe(1); // "d" was relinked
    expect(result.messages).toHaveLength(2);
  });

  it("handles multiple snip boundaries", () => {
    const entries: Entry[] = [
      makeMessageEntry("a", null, "user", "1"),
      makeMessageEntry("b", "a", "assistant", "2"),
      makeMessageEntry("c", "b", "user", "3"),
      makeMessageEntry("d", "c", "assistant", "4"),
      makeMessageEntry("e", "d", "user", "5"),
      {
        type: "snip-boundary",
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        snipMetadata: { removedUuids: ["b"] },
      },
      {
        type: "snip-boundary",
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        snipMetadata: { removedUuids: ["d"] },
      },
    ];

    const result = applySnipRemovals(entries);
    expect(result.messages).toHaveLength(3);
    expect(result.removedCount).toBe(2);
    expect((result.messages[0] as { content: string }).content).toBe("1");
    expect((result.messages[1] as { content: string }).content).toBe("3");
    expect((result.messages[2] as { content: string }).content).toBe("5");
  });

  it("handles chain of deleted parents (path compression)", () => {
    const entries: Entry[] = [
      makeMessageEntry("a", null, "user", "root"),
      makeMessageEntry("b", "a", "assistant", "del1"),
      makeMessageEntry("c", "b", "user", "del2"),
      makeMessageEntry("d", "c", "assistant", "del3"),
      makeMessageEntry("e", "d", "user", "survivor"),
      {
        type: "snip-boundary",
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        snipMetadata: { removedUuids: ["b", "c", "d"] },
      },
    ];

    const result = applySnipRemovals(entries);
    expect(result.messages).toHaveLength(2);
    expect(result.relinkedCount).toBe(1);
  });

  it("handles removing UUIDs that don't exist (no crash)", () => {
    const entries: Entry[] = [
      makeMessageEntry("a", null, "user", "hello"),
      {
        type: "snip-boundary",
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        snipMetadata: { removedUuids: ["nonexistent"] },
      },
    ];

    const result = applySnipRemovals(entries);
    expect(result.messages).toHaveLength(1);
    expect(result.removedCount).toBe(0);
  });
});

describe("snipMessagesByUuids", () => {
  it("removes specified UUIDs from in-memory entries", () => {
    const entries = [
      { uuid: "a" as UUID, parentUuid: null, message: { role: "user" as const, content: "hello" } },
      { uuid: "b" as UUID, parentUuid: "a" as UUID, message: { role: "assistant" as const, content: "hi" } as ChatMessage },
      { uuid: "c" as UUID, parentUuid: "b" as UUID, message: { role: "user" as const, content: "bye" } },
    ];

    const result = snipMessagesByUuids(entries, new Set(["b" as UUID]));
    expect(result.messages).toHaveLength(2);
    expect(result.removedCount).toBe(1);
    expect(result.relinkedCount).toBe(1);
  });

  it("no-ops when removing empty set", () => {
    const entries = [
      { uuid: "a" as UUID, parentUuid: null, message: { role: "user" as const, content: "hello" } },
    ];

    const result = snipMessagesByUuids(entries, new Set<UUID>());
    expect(result.messages).toHaveLength(1);
    expect(result.removedCount).toBe(0);
  });
});

describe("projectSnippedView", () => {
  it("filters out snipped indices", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
    ];

    const result = projectSnippedView(messages, new Set([1, 2]));
    expect(result).toHaveLength(2);
    expect((result[0] as { content: string }).content).toBe("1");
    expect((result[1] as { content: string }).content).toBe("4");
  });

  it("returns all messages when includeSnipped is true", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
    ];

    const result = projectSnippedView(messages, new Set([0]), { includeSnipped: true });
    expect(result).toHaveLength(2);
  });

  it("returns all messages when no snipped indices", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "1" },
    ];

    const result = projectSnippedView(messages, new Set());
    expect(result).toHaveLength(1);
  });
});
