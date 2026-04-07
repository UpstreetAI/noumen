import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { StreamEvent } from "../session/types.js";
import type { PermissionResponse } from "../permissions/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromiseResolver<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

export interface BufferedEvent {
  seq: number;
  event: StreamEvent;
}

export interface SessionState {
  id: string;
  abortController: AbortController;
  pendingPermission: PromiseResolver<PermissionResponse> | null;
  pendingInput: PromiseResolver<string> | null;
  pendingPermissionTimer: ReturnType<typeof setTimeout> | null;
  pendingInputTimer: ReturnType<typeof setTimeout> | null;
  lastActivity: number;
  sseResponse: ServerResponse | null;
  sseKeepaliveTimer: ReturnType<typeof setInterval> | null;
  eventBuffer: BufferedEvent[];
  sequenceNum: number;
  done: boolean;
  cwd?: string;
}

export interface ConnectionOverrides {
  cwd?: string;
}

export const DEFAULT_PENDING_TIMEOUT_MS = 120_000; // 2 minutes

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export function createSessionState(
  sessions: Map<string, SessionState>,
  requestedId: string | undefined,
  overrides: ConnectionOverrides,
): SessionState {
  if (requestedId && sessions.has(requestedId)) {
    throw new Error(`Session ${requestedId} already exists`);
  }
  const sessionId = requestedId ?? randomUUID();

  const session: SessionState = {
    id: sessionId,
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
    cwd: overrides.cwd,
  };

  sessions.set(sessionId, session);
  return session;
}

export function destroySession(
  sessions: Map<string, SessionState>,
  session: SessionState,
): void {
  session.abortController.abort();
  clearSseKeepalive(session);
  clearPendingPermissionTimer(session);
  clearPendingInputTimer(session);
  if (session.pendingPermission) {
    session.pendingPermission.reject(new Error("Session aborted"));
    session.pendingPermission = null;
  }
  if (session.pendingInput) {
    session.pendingInput.reject(new Error("Session aborted"));
    session.pendingInput = null;
  }
  if (session.sseResponse) {
    session.sseResponse.end();
    session.sseResponse = null;
  }
  sessions.delete(session.id);
}

export function reapIdleSessions(
  sessions: Map<string, SessionState>,
  timeoutMs: number | undefined,
): void {
  if (!timeoutMs) return;
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.lastActivity > timeoutMs) {
      destroySession(sessions, session);
    }
  }
}

// ---------------------------------------------------------------------------
// Permission / input bridging
// ---------------------------------------------------------------------------

export function bridgePermission(
  sessions: Map<string, SessionState>,
  sessionId: string,
  timeoutMs: number,
): Promise<PermissionResponse> {
  const session = sessions.get(sessionId);
  if (!session) return Promise.reject(new Error("Session not found"));
  return new Promise<PermissionResponse>((resolve, reject) => {
    session.pendingPermission = { resolve, reject };
    session.pendingPermissionTimer = setTimeout(() => {
      session.pendingPermissionTimer = null;
      if (session.pendingPermission) {
        session.pendingPermission.reject(new Error("Permission request timed out"));
        session.pendingPermission = null;
      }
    }, timeoutMs);
  });
}

export function bridgeUserInput(
  sessions: Map<string, SessionState>,
  sessionId: string,
  timeoutMs: number,
): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return Promise.reject(new Error("Session not found"));
  return new Promise<string>((resolve, reject) => {
    session.pendingInput = { resolve, reject };
    session.pendingInputTimer = setTimeout(() => {
      session.pendingInputTimer = null;
      if (session.pendingInput) {
        session.pendingInput.reject(new Error("User input request timed out"));
        session.pendingInput = null;
      }
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Timer helpers
// ---------------------------------------------------------------------------

export function clearPendingPermissionTimer(session: SessionState): void {
  if (session.pendingPermissionTimer) {
    clearTimeout(session.pendingPermissionTimer);
    session.pendingPermissionTimer = null;
  }
}

export function clearPendingInputTimer(session: SessionState): void {
  if (session.pendingInputTimer) {
    clearTimeout(session.pendingInputTimer);
    session.pendingInputTimer = null;
  }
}

export function clearSseKeepalive(session: SessionState): void {
  if (session.sseKeepaliveTimer) {
    clearInterval(session.sseKeepaliveTimer);
    session.sseKeepaliveTimer = null;
  }
}
