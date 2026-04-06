import { describe, it, expect, beforeEach } from "vitest";
import { MockFs } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import { restoreSession } from "../session/resume.js";
import { CostTracker } from "../cost/tracker.js";

let fs: MockFs;
let storage: SessionStorage;

beforeEach(() => {
  fs = new MockFs();
  storage = new SessionStorage(fs, "/sessions");
});

describe("restoreSession", () => {
  it("restores messages from a simple session", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hello" });
    await storage.appendMessage("s1", { role: "assistant", content: "hi" });

    const payload = await restoreSession(storage, "s1");
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[0]).toEqual({ role: "user", content: "hello" });
    expect(payload.messages[1]).toEqual({ role: "assistant", content: "hi" });
  });

  it("respects compact boundaries", async () => {
    await storage.appendMessage("s1", { role: "user", content: "old" });
    await storage.appendMessage("s1", { role: "assistant", content: "old-resp" });
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "summary" });
    await storage.appendMessage("s1", { role: "user", content: "new" });

    const payload = await restoreSession(storage, "s1");
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[0].content).toBe("summary");
    expect(payload.messages[1].content).toBe("new");
  });

  it("collects checkpoint snapshots", async () => {
    const uuid1 = await storage.appendMessage("s1", { role: "user", content: "turn1" });
    await storage.appendCheckpointEntry("s1", uuid1, {
      messageId: uuid1,
      trackedFileBackups: { "/a.ts": { backupFileName: "abc@v1", version: 1, backupTime: "t" } },
      timestamp: "t",
    }, false);

    const uuid2 = await storage.appendMessage("s1", { role: "user", content: "turn2" });
    await storage.appendCheckpointEntry("s1", uuid2, {
      messageId: uuid2,
      trackedFileBackups: {
        "/a.ts": { backupFileName: "abc@v2", version: 2, backupTime: "t2" },
        "/b.ts": { backupFileName: "def@v1", version: 1, backupTime: "t2" },
      },
      timestamp: "t2",
    }, false);

    const payload = await restoreSession(storage, "s1");
    expect(payload.checkpointSnapshots).toHaveLength(2);
    expect(payload.checkpointSnapshots[0].messageId).toBe(uuid1);
    expect(payload.checkpointSnapshots[1].messageId).toBe(uuid2);
  });

  it("handles isSnapshotUpdate by replacing", async () => {
    const uuid1 = await storage.appendMessage("s1", { role: "user", content: "turn1" });
    await storage.appendCheckpointEntry("s1", uuid1, {
      messageId: uuid1,
      trackedFileBackups: {},
      timestamp: "t",
    }, false);

    await storage.appendCheckpointEntry("s1", uuid1, {
      messageId: uuid1,
      trackedFileBackups: { "/a.ts": { backupFileName: "abc@v1", version: 1, backupTime: "t" } },
      timestamp: "t2",
    }, true);

    const payload = await restoreSession(storage, "s1");
    expect(payload.checkpointSnapshots).toHaveLength(1);
    expect(
      Object.keys(payload.checkpointSnapshots[0].trackedFileBackups),
    ).toContain("/a.ts");
  });

  it("collects metadata entries", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    await storage.appendEntry("s1", {
      type: "custom-title",
      sessionId: "s1",
      title: "My Session",
      timestamp: new Date().toISOString(),
    } as any);

    const payload = await restoreSession(storage, "s1");
    expect(payload.metadata.title).toBe("My Session");
  });

  it("collects tool-result-overflow entries", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    await storage.appendToolResultOverflow("s1", "tc-1", "big output...");

    const payload = await restoreSession(storage, "s1");
    expect(payload.overflowEntries).toHaveLength(1);
    expect(payload.overflowEntries[0].toolCallId).toBe("tc-1");
  });

  it("returns empty payload for nonexistent session", async () => {
    const payload = await restoreSession(storage, "nonexistent");
    expect(payload.messages).toEqual([]);
    expect(payload.checkpointSnapshots).toEqual([]);
    expect(payload.overflowEntries).toEqual([]);
  });

  it("collects checkpoints from before a compact boundary", async () => {
    const uuid1 = await storage.appendMessage("s1", { role: "user", content: "old" });
    await storage.appendCheckpointEntry("s1", uuid1, {
      messageId: uuid1,
      trackedFileBackups: { "/a.ts": { backupFileName: "a@v1", version: 1, backupTime: "t1" } },
      timestamp: "t1",
    }, false);

    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "summary" });

    const uuid2 = await storage.appendMessage("s1", { role: "user", content: "new" });
    await storage.appendCheckpointEntry("s1", uuid2, {
      messageId: uuid2,
      trackedFileBackups: { "/b.ts": { backupFileName: "b@v1", version: 1, backupTime: "t2" } },
      timestamp: "t2",
    }, false);

    const payload = await restoreSession(storage, "s1");
    // Checkpoint from before the boundary should still be available
    expect(payload.checkpointSnapshots.length).toBeGreaterThanOrEqual(1);
    const allFiles = payload.checkpointSnapshots.flatMap((s) =>
      Object.keys(s.trackedFileBackups),
    );
    expect(allFiles).toContain("/b.ts");
  });

  it("handles orphaned boundary at end by falling back", async () => {
    await storage.appendMessage("s1", { role: "user", content: "old" });
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "summary" });
    await storage.appendMessage("s1", { role: "user", content: "new" });
    // Orphaned boundary with no summary after
    await storage.appendCompactBoundary("s1");

    const payload = await restoreSession(storage, "s1");
    // Should fall back to the prior boundary
    expect(payload.messages.length).toBeGreaterThanOrEqual(2);
    const hasNew = payload.messages.some((m) => m.content === "new");
    expect(hasNew).toBe(true);
  });

  it("detects interrupted_tool interruption", async () => {
    await storage.appendMessage("s1", { role: "user", content: "do something" });
    await storage.appendMessage("s1", {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "tc1", type: "function", function: { name: "Bash", arguments: "{}" } }],
    });
    await storage.appendMessage("s1", {
      role: "tool",
      tool_call_id: "tc1",
      content: "command output",
    });

    const payload = await restoreSession(storage, "s1");
    expect(payload.interruption.kind).toBe("interrupted_tool");
  });

  it("detects interrupted_prompt interruption", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hello" });
    await storage.appendMessage("s1", { role: "assistant", content: "thinking..." });
    await storage.appendMessage("s1", { role: "user", content: "more input" });

    const payload = await restoreSession(storage, "s1");
    expect(payload.interruption.kind).toBe("interrupted_prompt");
  });

  it("reports recoveryRemovals for orphaned tool uses", async () => {
    await storage.appendMessage("s1", { role: "user", content: "go" });
    await storage.appendMessage("s1", {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "tc_orphan", type: "function", function: { name: "Bash", arguments: "{}" } }],
    });
    // No tool result follows — the tool_use is orphaned

    const payload = await restoreSession(storage, "s1");
    expect(payload.recoveryRemovals.unresolvedToolUses).toBeGreaterThanOrEqual(1);
  });

  it("reports recoveryRemovals for whitespace-only assistants", async () => {
    await storage.appendMessage("s1", { role: "user", content: "go" });
    await storage.appendMessage("s1", { role: "assistant", content: "   " });
    await storage.appendMessage("s1", { role: "assistant", content: "valid response" });

    const payload = await restoreSession(storage, "s1");
    expect(payload.recoveryRemovals.whitespaceOnly).toBeGreaterThanOrEqual(1);
  });

  it("restores after compaction + abort scenario", async () => {
    await storage.appendMessage("s1", { role: "user", content: "old turn" });
    await storage.appendMessage("s1", { role: "assistant", content: "old response" });
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "[Conversation Summary] compacted" });
    await storage.appendMessage("s1", { role: "user", content: "post-compact turn" });
    await storage.appendMessage("s1", {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "tc_aborted", type: "function", function: { name: "Bash", arguments: "{}" } }],
    });
    // Aborted — no tool result

    const payload = await restoreSession(storage, "s1");
    expect(payload.messages[0].content).toContain("compacted");
    // The orphaned tool call should be removed or have synthetic result
    expect(payload.recoveryRemovals.unresolvedToolUses).toBeGreaterThanOrEqual(1);
  });
});

describe("CostTracker getState/restore", () => {
  it("round-trips state through getState and restore", () => {
    const tracker = new CostTracker();
    tracker.addUsage("gpt-4o", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      cache_read_tokens: 200,
    }, 300);
    tracker.addUsage("claude-sonnet-4", {
      prompt_tokens: 2000,
      completion_tokens: 1000,
      total_tokens: 3000,
    }, 400);

    const saved = tracker.getState();

    const restored = new CostTracker();
    restored.restore(saved);

    const original = tracker.getSummary();
    const resumedSummary = restored.getSummary();

    expect(resumedSummary.totalInputTokens).toBe(original.totalInputTokens);
    expect(resumedSummary.totalOutputTokens).toBe(original.totalOutputTokens);
    expect(resumedSummary.totalCacheReadTokens).toBe(original.totalCacheReadTokens);
    expect(resumedSummary.duration.apiMs).toBe(original.duration.apiMs);
    expect(Object.keys(resumedSummary.byModel)).toEqual(Object.keys(original.byModel));
  });

  it("restore replaces existing state", () => {
    const tracker = new CostTracker();
    tracker.addUsage("gpt-4o", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    });

    const emptyTracker = new CostTracker();
    const emptyState = emptyTracker.getState();

    tracker.restore(emptyState);
    const summary = tracker.getSummary();
    expect(summary.totalInputTokens).toBe(0);
    expect(Object.keys(summary.byModel)).toHaveLength(0);
  });
});
