import { describe, it, expect, vi } from "vitest";
import type { StreamEvent } from "../session/types.js";
import type { SessionState } from "../server/session-state.js";
import {
  serializeEvent,
  pushEvent,
  getBufferedEventsAfter,
  writeSseEventRaw,
  MAX_EVENT_BUFFER,
} from "../server/event-buffer.js";

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    id: "sess-1",
    abortController: new AbortController(),
    pendingPermission: null,
    pendingInput: null,
    pendingPermissionTimer: null,
    pendingInputTimer: null,
    lastActivity: Date.now(),
    sseResponse: null,
    sseKeepaliveTimer: null,
    eventBuffer: [],
    sequenceNum: 0,
    done: false,
    ...overrides,
  };
}

describe("serializeEvent", () => {
  it("converts error events to JSON-safe objects", () => {
    const err = new Error("boom");
    err.name = "TestError";
    const event: StreamEvent = { type: "error", error: err };
    const result = serializeEvent(event);
    expect(result).toEqual({
      type: "error",
      error: { message: "boom", name: "TestError" },
    });
  });

  it("converts retry_exhausted events", () => {
    const err = new Error("fail");
    const event: StreamEvent = { type: "retry_exhausted", attempts: 3, error: err };
    const result = serializeEvent(event);
    expect(result.type).toBe("retry_exhausted");
    expect(result.attempts).toBe(3);
    expect((result.error as any).message).toBe("fail");
  });

  it("converts retry_attempt events", () => {
    const err = new Error("transient");
    const event = { type: "retry_attempt", attempt: 2, maxAttempts: 3, error: err } as unknown as StreamEvent;
    const result = serializeEvent(event);
    expect(result.type).toBe("retry_attempt");
    expect((result.error as any).message).toBe("transient");
  });

  it("passes through normal events unchanged", () => {
    const event: StreamEvent = { type: "text_delta", text: "hello" };
    const result = serializeEvent(event);
    expect(result).toEqual({ type: "text_delta", text: "hello" });
  });

  it("passes through compact_start events", () => {
    const event: StreamEvent = { type: "compact_start" };
    const result = serializeEvent(event);
    expect(result).toEqual({ type: "compact_start" });
  });
});

describe("pushEvent", () => {
  it("increments sequenceNum", () => {
    const session = makeSession();
    pushEvent(session, { type: "text_delta", text: "a" });
    expect(session.sequenceNum).toBe(1);
    pushEvent(session, { type: "text_delta", text: "b" });
    expect(session.sequenceNum).toBe(2);
  });

  it("appends to event buffer", () => {
    const session = makeSession();
    pushEvent(session, { type: "text_delta", text: "x" });
    expect(session.eventBuffer).toHaveLength(1);
    expect(session.eventBuffer[0].seq).toBe(1);
    expect(session.eventBuffer[0].event.type).toBe("text_delta");
  });

  it("writes to sseResponse when present", () => {
    const writeFn = vi.fn();
    const session = makeSession({ sseResponse: { write: writeFn } as any });
    pushEvent(session, { type: "text_delta", text: "hello" });
    expect(writeFn).toHaveBeenCalledOnce();
    const written = writeFn.mock.calls[0][0] as string;
    expect(written).toContain("id: 1");
    expect(written).toContain('"text_delta"');
  });

  it("does not write when sseResponse is null", () => {
    const session = makeSession();
    expect(() => pushEvent(session, { type: "compact_start" })).not.toThrow();
  });

  it("caps buffer at MAX_EVENT_BUFFER", () => {
    const session = makeSession();
    for (let i = 0; i < MAX_EVENT_BUFFER + 50; i++) {
      pushEvent(session, { type: "text_delta", text: `msg-${i}` });
    }
    expect(session.eventBuffer.length).toBe(MAX_EVENT_BUFFER);
    expect(session.eventBuffer[0].seq).toBe(51);
    expect(session.eventBuffer[session.eventBuffer.length - 1].seq).toBe(MAX_EVENT_BUFFER + 50);
  });
});

describe("getBufferedEventsAfter", () => {
  it("returns all events when afterSeq is 0", () => {
    const buffer = [
      { seq: 1, event: { type: "text_delta", text: "a" } as StreamEvent },
      { seq: 2, event: { type: "text_delta", text: "b" } as StreamEvent },
    ];
    const result = getBufferedEventsAfter(buffer, 0);
    expect(result).toHaveLength(2);
  });

  it("filters events <= afterSeq", () => {
    const buffer = [
      { seq: 1, event: { type: "text_delta", text: "a" } as StreamEvent },
      { seq: 2, event: { type: "text_delta", text: "b" } as StreamEvent },
      { seq: 3, event: { type: "text_delta", text: "c" } as StreamEvent },
    ];
    const result = getBufferedEventsAfter(buffer, 2);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(3);
  });

  it("returns empty when all events are <= afterSeq", () => {
    const buffer = [
      { seq: 1, event: { type: "text_delta", text: "a" } as StreamEvent },
      { seq: 2, event: { type: "text_delta", text: "b" } as StreamEvent },
    ];
    const result = getBufferedEventsAfter(buffer, 5);
    expect(result).toHaveLength(0);
  });

  it("does not mutate original buffer", () => {
    const buffer = [
      { seq: 1, event: { type: "text_delta", text: "a" } as StreamEvent },
    ];
    const result = getBufferedEventsAfter(buffer, 0);
    expect(result).not.toBe(buffer);
    expect(buffer).toHaveLength(1);
  });
});

describe("writeSseEventRaw", () => {
  it("writes SSE format with id and data", () => {
    const writeFn = vi.fn();
    const res = { write: writeFn } as any;
    writeSseEventRaw(res, 42, { type: "text_delta", text: "hi" });
    const written = writeFn.mock.calls[0][0] as string;
    expect(written).toBe('id: 42\ndata: {"type":"text_delta","text":"hi"}\n\n');
  });
});
