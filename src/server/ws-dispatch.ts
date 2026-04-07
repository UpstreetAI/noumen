import type { PermissionResponse } from "../permissions/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WsWebSocket = {
  on(event: "message", cb: (data: Buffer | string) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "pong", cb: () => void): void;
  send(data: string): void;
  ping(): void;
  close(): void;
  readyState: number;
};

export interface WsDispatchCallbacks {
  /** Start a new session with the given prompt, optional requested session ID. */
  onRun: (prompt: string, requestedSessionId: string | undefined) => Promise<string>;
  /** Send a follow-up message to an existing session. */
  onMessage: (sessionId: string, prompt: string) => void;
  /** Forward a permission response to a session. */
  onPermissionResponse: (sessionId: string, response: PermissionResponse) => void;
  /** Forward a user input response to a session. */
  onInputResponse: (sessionId: string, answer: string) => void;
  /** Abort/destroy a session. */
  onAbort: (sessionId: string) => void;
}

export interface WsDispatchContext {
  maxSessions: number | undefined;
  currentSessionCount: number;
}

export type WsDispatchResult =
  | { type: "ok" }
  | { type: "error"; error: string }
  | { type: "session_created"; sessionId: string }

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseWsMessage(raw: Buffer | string): Record<string, unknown> | null {
  try {
    return JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handleWsMessage(
  msg: Record<string, unknown>,
  ctx: WsDispatchContext,
  callbacks: WsDispatchCallbacks,
): Promise<WsDispatchResult> {
  const msgType = msg.type as string;

  if (msgType === "run") {
    if (ctx.maxSessions && ctx.currentSessionCount >= ctx.maxSessions) {
      return { type: "error", error: "Maximum sessions reached" };
    }
    if (typeof msg.prompt !== "string" || !msg.prompt.trim()) {
      return { type: "error", error: "Missing or empty prompt" };
    }
    try {
      const sessionId = await callbacks.onRun(
        msg.prompt,
        msg.sessionId as string | undefined,
      );
      return { type: "session_created", sessionId };
    } catch (err) {
      return { type: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (msgType === "message") {
    if (typeof msg.prompt !== "string" || !msg.prompt.trim()) {
      return { type: "error", error: "Missing or empty prompt" };
    }
    const sessionId = msg.sessionId as string;
    if (!sessionId) {
      return { type: "error", error: "Missing sessionId" };
    }
    callbacks.onMessage(sessionId, msg.prompt);
    return { type: "ok" };
  }

  if (msgType === "permission_response") {
    const sessionId = msg.sessionId as string;
    const { sessionId: _sid, type: _type, ...response } = msg;
    callbacks.onPermissionResponse(sessionId, response as unknown as PermissionResponse);
    return { type: "ok" };
  }

  if (msgType === "input_response") {
    const sessionId = msg.sessionId as string;
    callbacks.onInputResponse(sessionId, (msg.answer as string) ?? "");
    return { type: "ok" };
  }

  if (msgType === "abort") {
    const sessionId = msg.sessionId as string;
    if (sessionId) callbacks.onAbort(sessionId);
    return { type: "ok" };
  }

  return { type: "ok" };
}

export function wsSend(ws: WsWebSocket, data: unknown): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}
