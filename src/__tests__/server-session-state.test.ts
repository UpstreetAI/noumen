import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  type SessionState,
  createSessionState,
  destroySession,
  reapIdleSessions,
  bridgePermission,
  bridgeUserInput,
  clearPendingPermissionTimer,
  clearPendingInputTimer,
  clearSseKeepalive,
} from "../server/session-state.js";

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

describe("createSessionState", () => {
  it("creates session with auto-generated ID when no requestedId", () => {
    const sessions = new Map<string, SessionState>();
    const session = createSessionState(sessions, undefined, {});
    expect(session.id).toBeTruthy();
    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
    expect(sessions.has(session.id)).toBe(true);
    expect(session.done).toBe(false);
    expect(session.sequenceNum).toBe(0);
    expect(session.eventBuffer).toEqual([]);
  });

  it("creates session with custom requestedId", () => {
    const sessions = new Map<string, SessionState>();
    const session = createSessionState(sessions, "my-session", {});
    expect(session.id).toBe("my-session");
    expect(sessions.get("my-session")).toBe(session);
  });

  it("throws when requestedId already exists", () => {
    const sessions = new Map<string, SessionState>();
    createSessionState(sessions, "dup", {});
    expect(() => createSessionState(sessions, "dup", {})).toThrow("Session dup already exists");
  });

  it("applies cwd from ConnectionOverrides", () => {
    const sessions = new Map<string, SessionState>();
    const session = createSessionState(sessions, undefined, { cwd: "/tmp/test" });
    expect(session.cwd).toBe("/tmp/test");
  });
});

describe("destroySession", () => {
  it("aborts the abort controller", () => {
    const sessions = new Map<string, SessionState>();
    const session = makeSession();
    sessions.set(session.id, session);
    const abortSpy = vi.spyOn(session.abortController, "abort");
    destroySession(sessions, session);
    expect(abortSpy).toHaveBeenCalled();
  });

  it("removes session from map", () => {
    const sessions = new Map<string, SessionState>();
    const session = makeSession();
    sessions.set(session.id, session);
    destroySession(sessions, session);
    expect(sessions.has(session.id)).toBe(false);
  });

  it("rejects pending permission with 'Session aborted'", () => {
    const sessions = new Map<string, SessionState>();
    const session = makeSession();
    sessions.set(session.id, session);
    const rejectFn = vi.fn();
    session.pendingPermission = { resolve: vi.fn(), reject: rejectFn };
    destroySession(sessions, session);
    expect(rejectFn).toHaveBeenCalledWith(expect.objectContaining({ message: "Session aborted" }));
    expect(session.pendingPermission).toBeNull();
  });

  it("rejects pending input with 'Session aborted'", () => {
    const sessions = new Map<string, SessionState>();
    const session = makeSession();
    sessions.set(session.id, session);
    const rejectFn = vi.fn();
    session.pendingInput = { resolve: vi.fn(), reject: rejectFn };
    destroySession(sessions, session);
    expect(rejectFn).toHaveBeenCalledWith(expect.objectContaining({ message: "Session aborted" }));
    expect(session.pendingInput).toBeNull();
  });

  it("clears all timers", () => {
    const sessions = new Map<string, SessionState>();
    const session = makeSession();
    sessions.set(session.id, session);
    session.pendingPermissionTimer = setTimeout(() => {}, 60000);
    session.pendingInputTimer = setTimeout(() => {}, 60000);
    session.sseKeepaliveTimer = setInterval(() => {}, 60000);
    destroySession(sessions, session);
    expect(session.pendingPermissionTimer).toBeNull();
    expect(session.pendingInputTimer).toBeNull();
    expect(session.sseKeepaliveTimer).toBeNull();
  });

  it("ends sseResponse if present", () => {
    const sessions = new Map<string, SessionState>();
    const session = makeSession();
    sessions.set(session.id, session);
    const endFn = vi.fn();
    session.sseResponse = { end: endFn } as any;
    destroySession(sessions, session);
    expect(endFn).toHaveBeenCalled();
    expect(session.sseResponse).toBeNull();
  });
});

describe("reapIdleSessions", () => {
  it("does nothing when timeoutMs is undefined", () => {
    const sessions = new Map<string, SessionState>();
    const session = makeSession({ lastActivity: 0 });
    sessions.set(session.id, session);
    reapIdleSessions(sessions, undefined);
    expect(sessions.size).toBe(1);
  });

  it("reaps sessions idle longer than timeout", () => {
    const sessions = new Map<string, SessionState>();
    const stale = makeSession({ id: "stale", lastActivity: Date.now() - 10000 });
    const fresh = makeSession({ id: "fresh", lastActivity: Date.now() });
    sessions.set("stale", stale);
    sessions.set("fresh", fresh);
    reapIdleSessions(sessions, 5000);
    expect(sessions.has("stale")).toBe(false);
    expect(sessions.has("fresh")).toBe(true);
  });

  it("keeps sessions exactly at the timeout boundary", () => {
    const sessions = new Map<string, SessionState>();
    const session = makeSession({ lastActivity: Date.now() });
    sessions.set(session.id, session);
    reapIdleSessions(sessions, 5000);
    expect(sessions.size).toBe(1);
  });
});

describe("bridgePermission", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("rejects immediately when session is not found", async () => {
    const sessions = new Map<string, SessionState>();
    await expect(bridgePermission(sessions, "nope", 5000)).rejects.toThrow("Session not found");
  });

  it("resolves when permission is fulfilled", async () => {
    const sessions = new Map<string, SessionState>();
    const session = makeSession();
    sessions.set(session.id, session);

    const promise = bridgePermission(sessions, session.id, 60000);
    expect(session.pendingPermission).not.toBeNull();

    session.pendingPermission!.resolve({ behavior: "allow" } as any);
    const result = await promise;
    expect(result).toEqual({ behavior: "allow" });

    if (session.pendingPermissionTimer) clearTimeout(session.pendingPermissionTimer);
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    const sessions = new Map<string, SessionState>();
    const session = makeSession();
    sessions.set(session.id, session);

    const promise = bridgePermission(sessions, session.id, 100);
    vi.advanceTimersByTime(101);

    await expect(promise).rejects.toThrow("Permission request timed out");
    expect(session.pendingPermission).toBeNull();
  });
});

describe("bridgeUserInput", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("rejects immediately when session is not found", async () => {
    const sessions = new Map<string, SessionState>();
    await expect(bridgeUserInput(sessions, "nope", 5000)).rejects.toThrow("Session not found");
  });

  it("resolves when input is fulfilled", async () => {
    const sessions = new Map<string, SessionState>();
    const session = makeSession();
    sessions.set(session.id, session);

    const promise = bridgeUserInput(sessions, session.id, 60000);
    expect(session.pendingInput).not.toBeNull();

    session.pendingInput!.resolve("user answer");
    const result = await promise;
    expect(result).toBe("user answer");

    if (session.pendingInputTimer) clearTimeout(session.pendingInputTimer);
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    const sessions = new Map<string, SessionState>();
    const session = makeSession();
    sessions.set(session.id, session);

    const promise = bridgeUserInput(sessions, session.id, 100);
    vi.advanceTimersByTime(101);

    await expect(promise).rejects.toThrow("User input request timed out");
    expect(session.pendingInput).toBeNull();
  });
});

describe("timer helpers", () => {
  it("clearPendingPermissionTimer clears and nullifies", () => {
    const session = makeSession();
    session.pendingPermissionTimer = setTimeout(() => {}, 60000);
    clearPendingPermissionTimer(session);
    expect(session.pendingPermissionTimer).toBeNull();
  });

  it("clearPendingPermissionTimer is no-op when null", () => {
    const session = makeSession();
    expect(() => clearPendingPermissionTimer(session)).not.toThrow();
  });

  it("clearPendingInputTimer clears and nullifies", () => {
    const session = makeSession();
    session.pendingInputTimer = setTimeout(() => {}, 60000);
    clearPendingInputTimer(session);
    expect(session.pendingInputTimer).toBeNull();
  });

  it("clearSseKeepalive clears and nullifies", () => {
    const session = makeSession();
    session.sseKeepaliveTimer = setInterval(() => {}, 60000);
    clearSseKeepalive(session);
    expect(session.sseKeepaliveTimer).toBeNull();
  });
});
