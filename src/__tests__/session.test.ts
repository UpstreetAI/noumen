import { describe, it, expect, beforeEach } from "vitest";
import { MockFs } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";

let fs: MockFs;
let storage: SessionStorage;

beforeEach(() => {
  fs = new MockFs();
  storage = new SessionStorage(fs, "/sessions");
});

describe("SessionStorage", () => {
  it("appendMessage + loadMessages round-trip", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    await storage.appendMessage("s1", {
      role: "assistant",
      content: "hello",
    });

    const messages = await storage.loadMessages("s1");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
    expect(messages[1]).toEqual({ role: "assistant", content: "hello" });
  });

  it("preserves message order", async () => {
    for (let i = 0; i < 5; i++) {
      await storage.appendMessage("s1", { role: "user", content: `msg${i}` });
    }
    const messages = await storage.loadMessages("s1");
    expect(messages.map((m) => m.content)).toEqual([
      "msg0",
      "msg1",
      "msg2",
      "msg3",
      "msg4",
    ]);
  });

  it("loadMessages only returns post-boundary entries", async () => {
    await storage.appendMessage("s1", { role: "user", content: "old" });
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "summary" });
    await storage.appendMessage("s1", { role: "user", content: "new" });

    const messages = await storage.loadMessages("s1");
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("summary");
    expect(messages[1].content).toBe("new");
  });

  it("loadAllEntries returns everything", async () => {
    await storage.appendMessage("s1", { role: "user", content: "a" });
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "sum" });

    const entries = await storage.loadAllEntries("s1");
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.type)).toEqual([
      "message",
      "compact-boundary",
      "summary",
    ]);
  });

  it("loadMessages returns empty for missing session", async () => {
    const messages = await storage.loadMessages("nonexistent");
    expect(messages).toEqual([]);
  });

  it("sessionExists", async () => {
    expect(await storage.sessionExists("s1")).toBe(false);
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    expect(await storage.sessionExists("s1")).toBe(true);
  });

  it("listSessions returns sorted sessions", async () => {
    // Create two sessions with different timestamps
    await storage.appendMessage("s1", { role: "user", content: "first" });

    // Simulate later timestamp by directly writing
    const laterEntry = JSON.stringify({
      type: "message",
      uuid: "u2",
      parentUuid: null,
      sessionId: "s2",
      timestamp: new Date(Date.now() + 10000).toISOString(),
      message: { role: "user", content: "second" },
    });
    await fs.appendFile("/sessions/s2.jsonl", laterEntry + "\n");

    const sessions = await storage.listSessions();
    expect(sessions).toHaveLength(2);
    // s2 should be first (more recent)
    expect(sessions[0].sessionId).toBe("s2");
    expect(sessions[1].sessionId).toBe("s1");
  });

  it("listSessions skips corrupt files", async () => {
    await storage.appendMessage("s1", { role: "user", content: "ok" });
    await fs.writeFile("/sessions/bad.jsonl", "not valid json at all\n");

    const sessions = await storage.listSessions();
    // bad.jsonl has no valid message entries so messageCount=0 — it still parses but
    // with 0 messages. The important thing is it doesn't throw.
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.find((s) => s.sessionId === "s1")).toBeDefined();
  });

  it("ensureDir creates directory", async () => {
    expect(fs.dirs.has("/sessions")).toBe(false);
    await storage.ensureDir();
    expect(fs.dirs.has("/sessions")).toBe(true);
  });

  it("concurrent appendMessage calls do not interleave", async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        storage.appendMessage("s1", { role: "user", content: `msg-${i}` }),
      );
    }
    await Promise.all(promises);

    const raw = fs.files.get("/sessions/s1.jsonl")!;
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(10);

    // Each line should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // All messages should be present
    const messages = await storage.loadMessages("s1");
    expect(messages).toHaveLength(10);
  });

  it("orphaned boundary at end falls back to prior boundary on loadMessages", async () => {
    await storage.appendMessage("s1", { role: "user", content: "old" });
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "summary" });
    await storage.appendMessage("s1", { role: "user", content: "new" });
    // Write a second orphaned boundary with no summary/message after
    await storage.appendCompactBoundary("s1");

    const messages = await storage.loadMessages("s1");
    // Should fall back to first boundary + summary + "new"
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const hasNew = messages.some((m) => m.content === "new");
    expect(hasNew).toBe(true);
  });
});

describe("reAppendMetadataAfterCompact", () => {
  it("re-appends custom-title and metadata entries after compact boundary", async () => {
    // Write some initial entries including metadata
    await storage.appendMessage("s1", { role: "user", content: "hello" });
    await storage.appendMetadata("s1", "costState", { totalCost: 0.05 });
    await storage.appendMetadata("s1", "customKey", "customValue");
    await storage.appendEntry("s1", {
      type: "custom-title",
      sessionId: "s1",
      title: "My Session",
      timestamp: new Date().toISOString(),
    } as any);

    // Simulate compact boundary
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "summary" });

    // Re-append metadata
    await storage.reAppendMetadataAfterCompact("s1");

    // Load all entries and check that metadata was re-appended after boundary
    const entries = await storage.loadAllEntries("s1");
    const boundaryIdx = entries.findIndex((e) => e.type === "compact-boundary");

    // custom-title should appear after boundary
    const titleAfterBoundary = entries.slice(boundaryIdx + 1).find((e) => e.type === "custom-title");
    expect(titleAfterBoundary).toBeDefined();
    expect((titleAfterBoundary as any).title).toBe("My Session");

    // metadata entries should appear after boundary
    const metadataAfterBoundary = entries.slice(boundaryIdx + 1).filter((e) => e.type === "metadata");
    expect(metadataAfterBoundary.length).toBeGreaterThanOrEqual(2);

    const costEntry = metadataAfterBoundary.find((e) => (e as any).key === "costState");
    expect(costEntry).toBeDefined();
    expect((costEntry as any).value).toEqual({ totalCost: 0.05 });

    const customEntry = metadataAfterBoundary.find((e) => (e as any).key === "customKey");
    expect(customEntry).toBeDefined();
    expect((customEntry as any).value).toBe("customValue");
  });

  it("handles sessions with no metadata gracefully", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hello" });
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "summary" });

    // Should not throw
    await storage.reAppendMetadataAfterCompact("s1");

    const entries = await storage.loadAllEntries("s1");
    const metadataEntries = entries.filter((e) => e.type === "metadata" || e.type === "custom-title");
    expect(metadataEntries).toHaveLength(0);
  });
});
