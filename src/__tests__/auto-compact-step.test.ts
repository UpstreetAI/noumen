import { describe, it, expect, vi, beforeEach } from "vitest";
import { tryAutoCompactStep } from "../pipeline/auto-compact-step.js";
import { createAutoCompactTracking, type AutoCompactTrackingState } from "../compact/auto-compact.js";
import type { ChatMessage } from "../session/types.js";
import type { AIProvider } from "../providers/types.js";
import { SessionStorage } from "../session/storage.js";
import { MockFs } from "./helpers.js";

vi.mock("../compact/compact.js", () => ({
  compactConversation: (...args: unknown[]) => mockCompactConversation(...args),
}));

let mockCompactConversation: (...args: unknown[]) => Promise<ChatMessage[]>;

function makeLargeHistory(tokenEstimate: number): ChatMessage[] {
  const charsPer = Math.ceil(tokenEstimate * 4);
  return [
    { role: "user", content: "x".repeat(charsPer) },
    { role: "assistant", content: "ok" },
  ];
}

function makeProvider(): AIProvider {
  return {
    name: "mock",
    chat: vi.fn(),
    chatStream: vi.fn(),
  } as unknown as AIProvider;
}

function makeStorage(): SessionStorage {
  return new SessionStorage(new MockFs(), "/sessions");
}

describe("tryAutoCompactStep", () => {
  beforeEach(() => {
    mockCompactConversation = vi.fn(async () => [
      { role: "user", content: "compacted summary" } as ChatMessage,
    ]);
  });

  it("returns compacted: false with no events when below threshold", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const result = await tryAutoCompactStep(
      messages,
      { enabled: true, threshold: 999_999 },
      makeProvider(),
      "test-model",
      {
        lastUsage: undefined,
        anchorMessageIndex: undefined,
        microcompactTokensFreed: 0,
        querySource: undefined,
        autoCompactTracking: createAutoCompactTracking(),
      },
      [],
      "session-1",
      makeStorage(),
    );

    expect(result.compacted).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.messages).toBeUndefined();
  });

  it("returns compacted: true with messages and events when above threshold", async () => {
    const messages = makeLargeHistory(200_000);
    const compactedMsgs: ChatMessage[] = [
      { role: "user", content: "summary" },
    ];
    mockCompactConversation = vi.fn(async () => compactedMsgs);

    const tracking = createAutoCompactTracking();
    const result = await tryAutoCompactStep(
      messages,
      { enabled: true, threshold: 1_000 },
      makeProvider(),
      "test-model",
      {
        lastUsage: undefined,
        anchorMessageIndex: undefined,
        microcompactTokensFreed: 0,
        querySource: undefined,
        autoCompactTracking: tracking,
      },
      [],
      "session-2",
      makeStorage(),
    );

    expect(result.compacted).toBe(true);
    expect(result.messages).toEqual(compactedMsgs);

    const eventTypes = result.events.map((e) => e.type);
    expect(eventTypes).toContain("compact_start");
    expect(eventTypes).toContain("compact_complete");
    expect(tracking.consecutiveFailures).toBe(0);
  });

  it("returns compacted: false with auto_compact_failed event on error", async () => {
    const messages = makeLargeHistory(200_000);
    mockCompactConversation = vi.fn(async () => {
      throw new Error("provider down");
    });

    const tracking = createAutoCompactTracking();
    const result = await tryAutoCompactStep(
      messages,
      { enabled: true, threshold: 1_000 },
      makeProvider(),
      "test-model",
      {
        lastUsage: undefined,
        anchorMessageIndex: undefined,
        microcompactTokensFreed: 0,
        querySource: undefined,
        autoCompactTracking: tracking,
      },
      [],
      "session-3",
      makeStorage(),
    );

    expect(result.compacted).toBe(false);
    expect(result.messages).toBeUndefined();

    const failEvent = result.events.find((e) => e.type === "auto_compact_failed");
    expect(failEvent).toBeDefined();
    expect((failEvent as { error: Error }).error.message).toBe("provider down");
    expect(tracking.consecutiveFailures).toBe(1);
  });

  it("circuit breaker prevents compaction after max consecutive failures", async () => {
    const messages = makeLargeHistory(200_000);
    const tracking = createAutoCompactTracking(3);

    tracking.consecutiveFailures = 3;

    const result = await tryAutoCompactStep(
      messages,
      { enabled: true, threshold: 1_000 },
      makeProvider(),
      "test-model",
      {
        lastUsage: undefined,
        anchorMessageIndex: undefined,
        microcompactTokensFreed: 0,
        querySource: undefined,
        autoCompactTracking: tracking,
      },
      [],
      "session-4",
      makeStorage(),
    );

    expect(result.compacted).toBe(false);
    expect(result.events).toEqual([]);
    expect(mockCompactConversation).not.toHaveBeenCalled();
  });

  it("skips compaction when querySource is compact", async () => {
    const messages = makeLargeHistory(200_000);

    const result = await tryAutoCompactStep(
      messages,
      { enabled: true, threshold: 1_000 },
      makeProvider(),
      "test-model",
      {
        lastUsage: undefined,
        anchorMessageIndex: undefined,
        microcompactTokensFreed: 0,
        querySource: "compact",
        autoCompactTracking: createAutoCompactTracking(),
      },
      [],
      "session-5",
      makeStorage(),
    );

    expect(result.compacted).toBe(false);
    expect(result.events).toEqual([]);
  });

  it("passes tailMessagesToKeep and signal to compactConversation", async () => {
    const messages = makeLargeHistory(200_000);
    const controller = new AbortController();

    await tryAutoCompactStep(
      messages,
      { enabled: true, threshold: 1_000, tailMessagesToKeep: 3 },
      makeProvider(),
      "test-model",
      {
        lastUsage: undefined,
        anchorMessageIndex: undefined,
        microcompactTokensFreed: 0,
        querySource: undefined,
        autoCompactTracking: createAutoCompactTracking(),
        signal: controller.signal,
      },
      [],
      "session-6",
      makeStorage(),
    );

    expect(mockCompactConversation).toHaveBeenCalledTimes(1);
    const callArgs = (mockCompactConversation as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = callArgs[5];
    expect(opts.tailMessagesToKeep).toBe(3);
    expect(opts.signal).toBe(controller.signal);
  });
});
