import { describe, it, expect, vi } from "vitest";
import {
  handleWsMessage,
  parseWsMessage,
  wsSend,
  type WsDispatchCallbacks,
  type WsDispatchContext,
  type WsWebSocket,
} from "../server/ws-dispatch.js";

function makeCallbacks(overrides?: Partial<WsDispatchCallbacks>): WsDispatchCallbacks {
  return {
    onRun: vi.fn().mockResolvedValue("new-session-id"),
    onMessage: vi.fn(),
    onPermissionResponse: vi.fn(),
    onInputResponse: vi.fn(),
    onAbort: vi.fn(),
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<WsDispatchContext>): WsDispatchContext {
  return {
    maxSessions: undefined,
    currentSessionCount: 0,
    ...overrides,
  };
}

describe("parseWsMessage", () => {
  it("parses valid JSON string", () => {
    const result = parseWsMessage('{"type":"run","prompt":"hello"}');
    expect(result).toEqual({ type: "run", prompt: "hello" });
  });

  it("parses Buffer input", () => {
    const buf = Buffer.from('{"type":"abort"}');
    const result = parseWsMessage(buf);
    expect(result).toEqual({ type: "abort" });
  });

  it("returns null for invalid JSON", () => {
    expect(parseWsMessage("not json")).toBeNull();
  });
});

describe("handleWsMessage", () => {
  it("dispatches 'run' to onRun callback", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "run", prompt: "do something" },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "session_created", sessionId: "new-session-id" });
    expect(callbacks.onRun).toHaveBeenCalledWith("do something", undefined);
  });

  it("returns error when 'run' exceeds maxSessions", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "run", prompt: "hi" },
      makeCtx({ maxSessions: 2, currentSessionCount: 2 }),
      callbacks,
    );
    expect(result).toEqual({ type: "error", error: "Maximum sessions reached" });
    expect(callbacks.onRun).not.toHaveBeenCalled();
  });

  it("returns error when 'run' has missing prompt", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "run" },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "error", error: "Missing or empty prompt" });
  });

  it("returns error when 'run' has empty prompt", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "run", prompt: "   " },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "error", error: "Missing or empty prompt" });
  });

  it("returns error when onRun throws", async () => {
    const callbacks = makeCallbacks({
      onRun: vi.fn().mockRejectedValue(new Error("Duplicate session")),
    });
    const result = await handleWsMessage(
      { type: "run", prompt: "hi", sessionId: "dup" },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "error", error: "Duplicate session" });
  });

  it("dispatches 'message' to onMessage callback", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "message", sessionId: "sess-1", prompt: "follow-up" },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "ok" });
    expect(callbacks.onMessage).toHaveBeenCalledWith("sess-1", "follow-up");
  });

  it("returns error for 'message' with missing prompt", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "message", sessionId: "sess-1" },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "error", error: "Missing or empty prompt" });
  });

  it("returns error for 'message' with missing sessionId", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "message", prompt: "hi" },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "error", error: "Missing sessionId" });
  });

  it("dispatches 'permission_response' to onPermissionResponse", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "permission_response", sessionId: "sess-1", behavior: "allow" },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "ok" });
    expect(callbacks.onPermissionResponse).toHaveBeenCalledWith("sess-1", { behavior: "allow" });
  });

  it("dispatches 'input_response' to onInputResponse", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "input_response", sessionId: "sess-1", answer: "yes" },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "ok" });
    expect(callbacks.onInputResponse).toHaveBeenCalledWith("sess-1", "yes");
  });

  it("dispatches 'input_response' with missing answer as empty string", async () => {
    const callbacks = makeCallbacks();
    await handleWsMessage(
      { type: "input_response", sessionId: "sess-1" },
      makeCtx(),
      callbacks,
    );
    expect(callbacks.onInputResponse).toHaveBeenCalledWith("sess-1", "");
  });

  it("dispatches 'abort' to onAbort", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "abort", sessionId: "sess-1" },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "ok" });
    expect(callbacks.onAbort).toHaveBeenCalledWith("sess-1");
  });

  it("unknown message type returns ok (no-op)", async () => {
    const callbacks = makeCallbacks();
    const result = await handleWsMessage(
      { type: "unknown_thing" },
      makeCtx(),
      callbacks,
    );
    expect(result).toEqual({ type: "ok" });
  });

  it("passes requestedSessionId through on 'run'", async () => {
    const callbacks = makeCallbacks();
    await handleWsMessage(
      { type: "run", prompt: "hi", sessionId: "custom-id" },
      makeCtx(),
      callbacks,
    );
    expect(callbacks.onRun).toHaveBeenCalledWith("hi", "custom-id");
  });
});

describe("wsSend", () => {
  it("sends JSON when readyState is 1 (OPEN)", () => {
    const sendFn = vi.fn();
    const ws: WsWebSocket = {
      readyState: 1,
      send: sendFn,
      on: vi.fn(),
      ping: vi.fn(),
      close: vi.fn(),
    };
    wsSend(ws, { type: "hello" });
    expect(sendFn).toHaveBeenCalledWith('{"type":"hello"}');
  });

  it("does not send when readyState is not 1", () => {
    const sendFn = vi.fn();
    const ws: WsWebSocket = {
      readyState: 3,
      send: sendFn,
      on: vi.fn(),
      ping: vi.fn(),
      close: vi.fn(),
    };
    wsSend(ws, { type: "hello" });
    expect(sendFn).not.toHaveBeenCalled();
  });
});
