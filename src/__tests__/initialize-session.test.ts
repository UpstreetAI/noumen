import { describe, it, expect, vi, beforeEach } from "vitest";
import { initializeSession, type InitializeSessionParams } from "../pipeline/initialize-session.js";
import { SessionStorage } from "../session/storage.js";
import { MockFs } from "./helpers.js";
import {
  createContentReplacementState,
  type ContentReplacementState,
} from "../compact/tool-result-storage.js";
import type { ChatMessage, StreamEvent } from "../session/types.js";

vi.mock("../session/resume.js", () => ({
  restoreSession: vi.fn(),
}));
const { restoreSession: mockRestoreSession } = await import("../session/resume.js");

function makeParams(overrides?: Partial<InitializeSessionParams>): InitializeSessionParams {
  const fs = new MockFs();
  const storage = new SessionStorage(fs, "/sessions");
  return {
    storage,
    sessionId: "test-session",
    hooks: [],
    prompt: "Hello",
    resumeRequested: false,
    loaded: false,
    messages: [],
    contentReplacementState: createContentReplacementState(),
    isResumeRun: false,
    fs,
    ...overrides,
  };
}

describe("initializeSession", () => {
  beforeEach(() => {
    vi.mocked(mockRestoreSession).mockReset();
  });

  it("loads messages from storage on first run (not resume)", async () => {
    const fs = new MockFs();
    const storage = new SessionStorage(fs, "/sessions");
    const params = makeParams({ storage, fs, loaded: false, resumeRequested: false });

    const result = await initializeSession(params);

    expect(result.loaded).toBe(true);
    expect(result.resumeRequested).toBe(false);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages[result.messages.length - 1]).toEqual({ role: "user", content: "Hello" });
    expect(result.events.every((e) => e.type !== "session_resumed")).toBe(true);
  });

  it("skips loading when already loaded", async () => {
    const params = makeParams({
      loaded: true,
      messages: [{ role: "user", content: "prior" }],
    });

    const result = await initializeSession(params);

    expect(vi.mocked(mockRestoreSession)).not.toHaveBeenCalled();
    expect(result.loaded).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: "user", content: "prior" });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  it("restores session on resume and emits session_resumed event", async () => {
    vi.mocked(mockRestoreSession).mockResolvedValueOnce({
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "response" },
      ] as ChatMessage[],
      checkpointSnapshots: [],
      metadata: {},
      overflowEntries: [],
      contentReplacements: [],
      interruption: { kind: "none" },
      recoveryRemovals: { unresolvedToolUses: 0, whitespaceOnly: 0, orphanedThinking: 0 },
    });

    const params = makeParams({ resumeRequested: true, loaded: false });

    const result = await initializeSession(params);

    expect(vi.mocked(mockRestoreSession)).toHaveBeenCalledOnce();
    expect(result.resumeRequested).toBe(false);
    expect(result.loaded).toBe(true);
    const resumed = result.events.find((e) => e.type === "session_resumed");
    expect(resumed).toBeDefined();
    expect((resumed as { messageCount: number }).messageCount).toBe(2);
    expect(result.messages[result.messages.length - 1]).toEqual({ role: "user", content: "Hello" });
  });

  it("emits recovery_filtered events for non-zero removals", async () => {
    vi.mocked(mockRestoreSession).mockResolvedValueOnce({
      messages: [] as ChatMessage[],
      checkpointSnapshots: [],
      metadata: {},
      overflowEntries: [],
      contentReplacements: [],
      interruption: { kind: "none" },
      recoveryRemovals: {
        unresolvedToolUses: 3,
        whitespaceOnly: 0,
        orphanedThinking: 1,
      },
    });

    const params = makeParams({ resumeRequested: true, loaded: false });
    const result = await initializeSession(params);

    const recoveryEvents = result.events.filter((e) => e.type === "recovery_filtered");
    expect(recoveryEvents).toHaveLength(2);
    expect(recoveryEvents[0]).toMatchObject({ filterName: "unresolvedToolUses", removedCount: 3 });
    expect(recoveryEvents[1]).toMatchObject({ filterName: "orphanedThinking", removedCount: 1 });
  });

  it("emits interrupted_turn_detected when interruption detected", async () => {
    vi.mocked(mockRestoreSession).mockResolvedValueOnce({
      messages: [] as ChatMessage[],
      checkpointSnapshots: [],
      metadata: {},
      overflowEntries: [],
      contentReplacements: [],
      interruption: { kind: "interrupted_tool" },
      recoveryRemovals: { unresolvedToolUses: 0, whitespaceOnly: 0, orphanedThinking: 0 },
    });

    const params = makeParams({ resumeRequested: true, loaded: false });
    const result = await initializeSession(params);

    const interruptEvent = result.events.find((e) => e.type === "interrupted_turn_detected");
    expect(interruptEvent).toBeDefined();
    expect((interruptEvent as { kind: string }).kind).toBe("interrupted_tool");
  });

  it("calls checkpointManager.makeSnapshot and emits checkpoint_snapshot", async () => {
    const checkpointManager = {
      makeSnapshot: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue({
        snapshots: [{ messageId: "snap-1", trackedFileBackups: {} }],
      }),
      restoreStateFromEntries: vi.fn(),
    } as unknown as import("../checkpoint/manager.js").FileCheckpointManager;

    const params = makeParams({ loaded: true, checkpointManager });
    const result = await initializeSession(params);

    expect(checkpointManager.makeSnapshot).toHaveBeenCalled();
    const cpEvent = result.events.find((e) => e.type === "checkpoint_snapshot");
    expect(cpEvent).toBeDefined();
  });

  it("restores costTracker state on resume", async () => {
    const costTracker = {
      restore: vi.fn(),
      addUsage: vi.fn(),
      getSummary: vi.fn(),
      getState: vi.fn(),
    } as unknown as import("../cost/tracker.js").CostTracker;

    const costState = { byModel: {}, totalApiMs: 0, wallStartMs: Date.now() };
    vi.mocked(mockRestoreSession).mockResolvedValueOnce({
      messages: [] as ChatMessage[],
      checkpointSnapshots: [],
      metadata: {},
      costState,
      overflowEntries: [],
      contentReplacements: [],
      interruption: { kind: "none" },
      recoveryRemovals: { unresolvedToolUses: 0, whitespaceOnly: 0, orphanedThinking: 0 },
    });

    const params = makeParams({ resumeRequested: true, loaded: false, costTracker });
    await initializeSession(params);

    expect(costTracker.restore).toHaveBeenCalledWith(costState);
  });

  it("restores checkpoint state on resume", async () => {
    const checkpointManager = {
      makeSnapshot: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue({
        snapshots: [{ messageId: "snap-1", trackedFileBackups: {} }],
      }),
      restoreStateFromEntries: vi.fn(),
    } as unknown as import("../checkpoint/manager.js").FileCheckpointManager;

    const snapshots = [{
      messageId: "m1",
      trackedFileBackups: { "/a": { backupFileName: "a.bak", version: 1, backupTime: new Date().toISOString() } },
      timestamp: new Date().toISOString(),
    }];
    vi.mocked(mockRestoreSession).mockResolvedValueOnce({
      messages: [] as ChatMessage[],
      checkpointSnapshots: snapshots,
      metadata: {},
      overflowEntries: [],
      contentReplacements: [],
      interruption: { kind: "none" },
      recoveryRemovals: { unresolvedToolUses: 0, whitespaceOnly: 0, orphanedThinking: 0 },
    });

    const params = makeParams({ resumeRequested: true, loaded: false, checkpointManager });
    await initializeSession(params);

    expect(checkpointManager.restoreStateFromEntries).toHaveBeenCalledWith(snapshots);
  });

  it("generates a turnMessageId", async () => {
    const params = makeParams({ loaded: true });
    const result = await initializeSession(params);
    expect(result.turnMessageId).toBeDefined();
    expect(typeof result.turnMessageId).toBe("string");
    expect(result.turnMessageId.length).toBeGreaterThan(0);
  });

  it("appends user message to storage", async () => {
    const fs = new MockFs();
    const storage = new SessionStorage(fs, "/sessions");
    const params = makeParams({ storage, fs, loaded: true });

    const result = await initializeSession(params);

    const last = result.messages[result.messages.length - 1];
    expect(last).toEqual({ role: "user", content: "Hello" });
  });

  it("handles content array prompt", async () => {
    const params = makeParams({
      loaded: true,
      prompt: [{ type: "text", text: "multi-part prompt" }],
    });

    const result = await initializeSession(params);

    const last = result.messages[result.messages.length - 1];
    expect(last).toEqual({
      role: "user",
      content: [{ type: "text", text: "multi-part prompt" }],
    });
  });
});
