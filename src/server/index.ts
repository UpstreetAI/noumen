import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Agent } from "../agent.js";
import type { StreamEvent } from "../session/types.js";
import type { PermissionResponse } from "../permissions/types.js";

import {
  type SessionState,
  type ConnectionOverrides,
  DEFAULT_PENDING_TIMEOUT_MS,
  createSessionState,
  destroySession,
  reapIdleSessions,
  bridgePermission,
  bridgeUserInput,
  clearPendingPermissionTimer,
  clearPendingInputTimer,
  clearSseKeepalive,
} from "./session-state.js";

import {
  MAX_EVENT_BUFFER,
  serializeEvent,
  pushEvent,
  getBufferedEventsAfter,
  writeSseEventRaw,
} from "./event-buffer.js";

import {
  type WsWebSocket,
  type WsDispatchCallbacks,
  handleWsMessage as dispatchWsMessage,
  parseWsMessage,
  wsSend,
} from "./ws-dispatch.js";

type MaybePromise<T> = T | Promise<T>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576; // 1 MB
const SHUTDOWN_DRAIN_MS = 500;
const WS_PING_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServerOptions {
  port: number;
  host?: string;
  /** Enable WebSocket transport (default true). Requires `ws` peer dependency. */
  ws?: boolean;
  auth?: AuthConfig;
  /** Maximum number of concurrent sessions (default unlimited). */
  maxSessions?: number;
  /** Automatically clean up sessions idle longer than this (ms). No timeout by default. */
  idleTimeoutMs?: number;
  /** Called on every new connection; return overrides for the session. */
  onConnection?: (info: ConnectionInfo) => MaybePromise<ConnectionOverrides>;
  onError?: (err: Error) => void;
  /** Enable CORS for browser clients (default true). */
  cors?: boolean;
  /** Timeout for pending permission/input responses before rejecting (ms). Default 120000. */
  pendingTimeoutMs?: number;
}

/**
 * Options for `createRequestHandler()` — same as `ServerOptions` but without
 * `port` / `host` / `ws` since the caller owns the HTTP server.
 */
export interface RequestHandlerOptions {
  auth?: AuthConfig;
  maxSessions?: number;
  idleTimeoutMs?: number;
  onConnection?: (info: ConnectionInfo) => MaybePromise<ConnectionOverrides>;
  onError?: (err: Error) => void;
  cors?: boolean;
  pendingTimeoutMs?: number;
}

export type AuthConfig =
  | { type: "bearer"; token: string }
  | { type: "custom"; verify: (req: IncomingMessage) => MaybePromise<AuthResult | null> };

export interface AuthResult {
  [key: string]: unknown;
}

export interface ConnectionInfo {
  auth: AuthResult;
  remoteAddress?: string;
}

// Re-export types that consumers might need
export type { ConnectionOverrides, SessionState, BufferedEvent, PromiseResolver } from "./session-state.js";

type WsServer = {
  on(event: "connection", cb: (ws: WsWebSocket, req: IncomingMessage) => void): void;
  close(cb?: () => void): void;
};

// ---------------------------------------------------------------------------
// NoumenServer
// ---------------------------------------------------------------------------

export class NoumenServer {
  private code: Agent;
  private options: ServerOptions;
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private wss: WsServer | null = null;
  private sessions = new Map<string, SessionState>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(code: Agent, options: ServerOptions) {
    this.code = code;
    this.options = options;
  }

  async start(): Promise<void> {
    this.httpServer = createHttpServer((req, res) => this.handleRequest(req, res));

    if (this.options.ws !== false) {
      await this.initWebSocket();
    }

    this.ensureIdleReaper();

    return new Promise<void>((resolve, reject) => {
      const host = this.options.host ?? "127.0.0.1";
      this.httpServer!.listen(this.options.port, host, () => resolve());
      this.httpServer!.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));

    for (const session of this.sessions.values()) {
      destroySession(this.sessions, session);
    }

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }

    if (this.httpServer) {
      if (typeof (this.httpServer as any).closeAllConnections === "function") {
        (this.httpServer as any).closeAllConnections();
      }
      await new Promise<void>((resolve, reject) =>
        this.httpServer!.close((err) => (err ? reject(err) : resolve())),
      );
      this.httpServer = null;
    }
  }

  getActiveSessions(): Map<string, { id: string; lastActivity: number; done: boolean }> {
    const result = new Map<string, { id: string; lastActivity: number; done: boolean }>();
    for (const [id, s] of this.sessions) {
      result.set(id, { id: s.id, lastActivity: s.lastActivity, done: s.done });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // WebSocket setup
  // -------------------------------------------------------------------------

  private async initWebSocket(): Promise<void> {
    let WsServerCtor: new (opts: { server: ReturnType<typeof createHttpServer> }) => WsServer;
    try {
      const ws = await import("ws");
      WsServerCtor = (ws as any).WebSocketServer ?? (ws as any).default?.WebSocketServer;
    } catch {
      throw new Error(
        "noumen/server: WebSocket support requires the 'ws' package. " +
        "Install it with: npm install ws\n" +
        "Or disable WebSocket with { ws: false } in ServerOptions.",
      );
    }

    this.wss = new WsServerCtor({ server: this.httpServer! });
    this.wss.on("connection", (ws, req) => {
      this.handleWsConnection(ws, req).catch((err) =>
        this.options.onError?.(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }

  /**
   * Handle an HTTP request. Used internally by `start()` and exposed for
   * `createRequestHandler()` so the same logic can be mounted on an
   * external Express / Fastify / Hono server.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.ensureIdleReaper();
    return this.handleHttp(req, res).catch((err) => {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      if (!res.headersSent) jsonResponse(res, 500, { error: "Internal server error" });
    });
  }

  private idleReaperStarted = false;

  private ensureIdleReaper(): void {
    if (this.idleReaperStarted || !this.options.idleTimeoutMs) return;
    this.idleReaperStarted = true;
    const interval = Math.max(this.options.idleTimeoutMs / 2, 1000);
    this.idleTimer = setInterval(() => reapIdleSessions(this.sessions, this.options.idleTimeoutMs), interval);
    this.idleTimer.unref();
  }

  // -------------------------------------------------------------------------
  // HTTP routing
  // -------------------------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.options.cors !== false) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Last-Event-ID");
    }

    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (path === "/health" && method === "GET") {
      return jsonResponse(res, 200, { status: "ok", sessions: this.sessions.size });
    }

    if (this.options.auth) {
      const authResult = await this.authenticate(req);
      if (!authResult) {
        return jsonResponse(res, 401, { error: "Unauthorized" });
      }
    }

    if (path === "/sessions" && method === "POST") {
      return this.handleCreateSession(req, res);
    }

    if (path === "/sessions" && method === "GET") {
      return this.handleListSessions(res);
    }

    const sessionMatch = path.match(/^\/sessions\/([^/]+)(?:\/(.+))?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const sub = sessionMatch[2] ?? "";

      if (sub === "events" && method === "GET") return this.handleSseStream(sessionId, req, res);
      if (sub === "permissions" && method === "POST") return this.handlePermissionResponse(sessionId, req, res);
      if (sub === "input" && method === "POST") return this.handleInputResponse(sessionId, req, res);
      if (sub === "messages" && method === "POST") return this.handleSendMessage(sessionId, req, res);
      if (sub === "" && method === "DELETE") return this.handleDeleteSession(sessionId, res);
    }

    jsonResponse(res, 404, { error: "Not found" });
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private async authenticate(req: IncomingMessage): Promise<AuthResult | null> {
    const auth = this.options.auth;
    if (!auth) return {};

    if (auth.type === "bearer") {
      const header = req.headers.authorization;
      if (header === `Bearer ${auth.token}`) return {};
      return null;
    }

    return auth.verify(req);
  }

  // -------------------------------------------------------------------------
  // REST handlers
  // -------------------------------------------------------------------------

  private async handleCreateSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const { prompt, sessionId: requestedId } = body as { prompt?: string; sessionId?: string };

    if (!prompt || typeof prompt !== "string") {
      return jsonResponse(res, 400, { error: "Missing required field: prompt" });
    }

    if (this.options.maxSessions && this.sessions.size >= this.options.maxSessions) {
      return jsonResponse(res, 429, { error: "Maximum sessions reached" });
    }

    const overrides = await this.resolveConnectionOverrides(req);
    const session = createSessionState(this.sessions, requestedId, overrides);

    this.runAgentSse(session, prompt, false);

    jsonResponse(res, 201, {
      sessionId: session.id,
      eventsUrl: `/sessions/${session.id}/events`,
    });
  }

  private handleListSessions(res: ServerResponse): void {
    const sessions = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      lastActivity: s.lastActivity,
      done: s.done,
    }));
    jsonResponse(res, 200, sessions);
  }

  private handleSseStream(sessionId: string, req: IncomingMessage, res: ServerResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session) return jsonResponse(res, 404, { error: "Session not found" });

    if (session.sseResponse) {
      const oldRes = session.sseResponse;
      writeSseEventRaw(oldRes, session.sequenceNum + 1, { type: "subscriber_replaced" });
      oldRes.end();
      clearSseKeepalive(session);
      session.sseResponse = null;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const resumeAfterSeq = lastEventId ? parseInt(lastEventId, 10) : 0;

    const eventsToReplay = getBufferedEventsAfter(session.eventBuffer, resumeAfterSeq);
    for (const buffered of eventsToReplay) {
      writeSseEventRaw(res, buffered.seq, serializeEvent(buffered.event));
    }
    session.eventBuffer = [];
    session.sseResponse = res;

    this.startSseKeepalive(session);

    res.on("close", () => {
      if (session.sseResponse === res) {
        clearSseKeepalive(session);
        session.sseResponse = null;
      }
    });
  }

  private async handlePermissionResponse(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return jsonResponse(res, 404, { error: "Session not found" });
    if (!session.pendingPermission) return jsonResponse(res, 409, { error: "No pending permission request" });

    const body = (await readBody(req)) as PermissionResponse;
    clearPendingPermissionTimer(session);
    session.pendingPermission.resolve(body);
    session.pendingPermission = null;
    jsonResponse(res, 200, { ok: true });
  }

  private async handleInputResponse(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return jsonResponse(res, 404, { error: "Session not found" });
    if (!session.pendingInput) return jsonResponse(res, 409, { error: "No pending input request" });

    const body = (await readBody(req)) as { answer?: string };
    if (typeof body.answer !== "string") {
      return jsonResponse(res, 400, { error: "Missing required field: answer" });
    }

    clearPendingInputTimer(session);
    session.pendingInput.resolve(body.answer);
    session.pendingInput = null;
    jsonResponse(res, 200, { ok: true });
  }

  private async handleSendMessage(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return jsonResponse(res, 404, { error: "Session not found" });
    if (!session.done) return jsonResponse(res, 409, { error: "Session is still running" });

    const body = (await readBody(req)) as { prompt?: string };
    if (!body.prompt || typeof body.prompt !== "string") {
      return jsonResponse(res, 400, { error: "Missing required field: prompt" });
    }

    session.done = false;
    session.abortController = new AbortController();
    this.runAgentSse(session, body.prompt, true);
    jsonResponse(res, 200, { ok: true });
  }

  private handleDeleteSession(sessionId: string, res: ServerResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session) return jsonResponse(res, 404, { error: "Session not found" });
    destroySession(this.sessions, session);
    jsonResponse(res, 200, { ok: true });
  }

  // -------------------------------------------------------------------------
  // WebSocket handling
  // -------------------------------------------------------------------------

  private async handleWsConnection(ws: WsWebSocket, req: IncomingMessage): Promise<void> {
    if (this.options.auth) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const tokenParam = url.searchParams.get("token");
      if (tokenParam && this.options.auth.type === "bearer") {
        if (tokenParam !== this.options.auth.token) {
          ws.close();
          return;
        }
      } else {
        const authResult = await this.authenticate(req);
        if (!authResult) {
          ws.close();
          return;
        }
      }
    }

    const wsSessions = new Set<string>();

    let pongReceived = true;
    const pingTimer = setInterval(() => {
      if (!pongReceived) {
        ws.close();
        return;
      }
      pongReceived = false;
      try { ws.ping(); } catch { /* connection may already be closing */ }
    }, WS_PING_INTERVAL_MS);

    ws.on("pong", () => { pongReceived = true; });

    const callbacks: WsDispatchCallbacks = {
      onRun: async (prompt, requestedSessionId) => {
        const overrides = await this.resolveConnectionOverrides(req);
        const session = createSessionState(this.sessions, requestedSessionId, overrides);
        wsSessions.add(session.id);
        this.runAgentWs(session, prompt, ws, false);
        return session.id;
      },
      onMessage: (sessionId, prompt) => {
        const session = this.sessions.get(sessionId);
        if (!session) { wsSend(ws, { type: "error", error: "Session not found" }); return; }
        if (!session.done) { wsSend(ws, { type: "error", error: "Session is still running" }); return; }
        session.done = false;
        session.abortController = new AbortController();
        this.runAgentWs(session, prompt, ws, true);
      },
      onPermissionResponse: (sessionId, response) => {
        const session = this.sessions.get(sessionId);
        if (!session?.pendingPermission) return;
        clearPendingPermissionTimer(session);
        session.pendingPermission.resolve(response);
        session.pendingPermission = null;
      },
      onInputResponse: (sessionId, answer) => {
        const session = this.sessions.get(sessionId);
        if (!session?.pendingInput) return;
        clearPendingInputTimer(session);
        session.pendingInput.resolve(answer);
        session.pendingInput = null;
      },
      onAbort: (sessionId) => {
        const session = this.sessions.get(sessionId);
        if (session) destroySession(this.sessions, session);
      },
    };

    ws.on("message", async (raw) => {
      try {
        const msg = parseWsMessage(raw);
        if (!msg) { wsSend(ws, { type: "error", error: "Invalid JSON" }); return; }
        const result = await dispatchWsMessage(msg, {
          maxSessions: this.options.maxSessions,
          currentSessionCount: this.sessions.size,
        }, callbacks);
        if (result.type === "error") {
          wsSend(ws, { type: "error", error: result.error });
        } else if (result.type === "session_created") {
          wsSend(ws, { type: "session_created", sessionId: result.sessionId });
        }
      } catch (err) {
        wsSend(ws, { type: "error", error: String(err) });
      }
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      for (const sid of wsSessions) {
        const session = this.sessions.get(sid);
        if (session) destroySession(this.sessions, session);
      }
    });

    ws.on("error", () => {
      clearInterval(pingTimer);
    });
  }

  // -------------------------------------------------------------------------
  // Agent runners
  // -------------------------------------------------------------------------

  private async makeThread(session: SessionState, resume: boolean) {
    const timeoutMs = this.options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
    const handlers = {
      cwd: session.cwd,
      permissionHandler: (_req: import("../permissions/types.js").PermissionRequest) =>
        bridgePermission(this.sessions, session.id, timeoutMs),
      userInputHandler: (_q: string) =>
        bridgeUserInput(this.sessions, session.id, timeoutMs),
    };

    return resume
      ? this.code.resumeThread(session.id, handlers)
      : this.code.createThread({ sessionId: session.id, ...handlers });
  }

  private runAgentSse(session: SessionState, prompt: string, resume: boolean): void {
    const run = async () => {
      try {
        const thread = await this.makeThread(session, resume);
        for await (const event of thread.run(prompt, { signal: session.abortController.signal })) {
          pushEvent(session, event);
          session.lastActivity = Date.now();
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          pushEvent(session, {
            type: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      } finally {
        session.done = true;
      }
    };
    run().catch((err) => this.options.onError?.(err instanceof Error ? err : new Error(String(err))));
  }

  private runAgentWs(session: SessionState, prompt: string, ws: WsWebSocket, resume: boolean): void {
    const run = async () => {
      try {
        const thread = await this.makeThread(session, resume);
        for await (const event of thread.run(prompt, { signal: session.abortController.signal })) {
          session.sequenceNum++;
          wsSend(ws, { ...serializeEvent(event), sessionId: session.id, seq: session.sequenceNum });
          session.lastActivity = Date.now();
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          wsSend(ws, { type: "error", sessionId: session.id, error: String(err) });
        }
      } finally {
        session.done = true;
      }
    };
    run().catch((err) => this.options.onError?.(err instanceof Error ? err : new Error(String(err))));
  }

  private startSseKeepalive(session: SessionState): void {
    clearSseKeepalive(session);
    session.sseKeepaliveTimer = setInterval(() => {
      if (session.sseResponse && !session.sseResponse.destroyed) {
        session.sseResponse.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);
    session.sseKeepaliveTimer.unref();
  }

  private async resolveConnectionOverrides(req: IncomingMessage): Promise<ConnectionOverrides> {
    if (!this.options.onConnection) return {};
    const auth = (await this.authenticate(req)) ?? {};
    return this.options.onConnection({ auth, remoteAddress: req.socket.remoteAddress });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createServer(code: Agent, options: ServerOptions): NoumenServer {
  return new NoumenServer(code, options);
}

/**
 * Create a `(req, res)` handler that can be mounted on any Node HTTP
 * framework (Express, Fastify, Hono, bare `http.createServer`, etc.).
 *
 * ```ts
 * import express from "express";
 * import { createRequestHandler } from "noumen/server";
 *
 * const app = express();
 * app.use("/agent", createRequestHandler(code, { auth: { type: "bearer", token: "..." } }));
 * ```
 *
 * WebSocket is not supported in middleware mode — use `createServer()` for WS.
 */
export function createRequestHandler(
  code: Agent,
  options?: RequestHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const serverOpts: ServerOptions = {
    port: 0,
    ws: false,
    ...options,
  };
  const server = new NoumenServer(code, serverOpts);
  return (req, res) => { server.handleRequest(req, res); };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        rejected = true;
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}
