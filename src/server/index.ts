import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Agent } from "../agent.js";
import type { StreamEvent } from "../session/types.js";
import type { PermissionResponse } from "../permissions/types.js";

type MaybePromise<T> = T | Promise<T>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576; // 1 MB
const MAX_EVENT_BUFFER = 1000;
const DEFAULT_PENDING_TIMEOUT_MS = 120_000; // 2 minutes
const WS_PING_INTERVAL_MS = 30_000;
const SHUTDOWN_DRAIN_MS = 500;

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

export interface ConnectionOverrides {
  cwd?: string;
}

interface PromiseResolver<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

interface BufferedEvent {
  seq: number;
  event: StreamEvent;
}

interface SessionState {
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

type WsWebSocket = {
  on(event: "message", cb: (data: Buffer | string) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "pong", cb: () => void): void;
  send(data: string): void;
  ping(): void;
  close(): void;
  readyState: number;
};

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
      const host = this.options.host ?? "0.0.0.0";
      this.httpServer!.listen(this.options.port, host, () => resolve());
      this.httpServer!.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    // Signal all sessions to stop, then give a brief drain period
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));

    for (const session of this.sessions.values()) {
      this.destroySession(session);
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
    this.idleTimer = setInterval(() => this.reapIdleSessions(), interval);
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
    const session = this.createSessionState(requestedId, overrides);

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

    // Handle subscriber conflict: notify the old listener before replacing
    if (session.sseResponse) {
      const oldRes = session.sseResponse;
      writeSseEventRaw(oldRes, session.sequenceNum + 1, { type: "subscriber_replaced" });
      oldRes.end();
      this.clearSseKeepalive(session);
      session.sseResponse = null;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Support Last-Event-ID for resumption after reconnect
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const resumeAfterSeq = lastEventId ? parseInt(lastEventId, 10) : 0;

    for (const buffered of session.eventBuffer) {
      if (resumeAfterSeq && buffered.seq <= resumeAfterSeq) continue;
      writeSseEventRaw(res, buffered.seq, serializeEvent(buffered.event));
    }
    session.eventBuffer = [];
    session.sseResponse = res;

    // Start keepalive interval
    this.startSseKeepalive(session);

    res.on("close", () => {
      if (session.sseResponse === res) {
        this.clearSseKeepalive(session);
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
    this.clearPendingPermissionTimer(session);
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

    this.clearPendingInputTimer(session);
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
    this.destroySession(session);
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

    // Ping/pong health check
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

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        await this.handleWsMessage(ws, msg, wsSessions, req);
      } catch (err) {
        wsSend(ws, { type: "error", error: String(err) });
      }
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      for (const sid of wsSessions) {
        const session = this.sessions.get(sid);
        if (session) this.destroySession(session);
      }
    });

    ws.on("error", () => {
      clearInterval(pingTimer);
    });
  }

  private async handleWsMessage(
    ws: WsWebSocket,
    msg: Record<string, unknown>,
    wsSessions: Set<string>,
    req: IncomingMessage,
  ): Promise<void> {
    const msgType = msg.type as string;

    if (msgType === "run") {
      if (this.options.maxSessions && this.sessions.size >= this.options.maxSessions) {
        wsSend(ws, { type: "error", error: "Maximum sessions reached" });
        return;
      }
      const overrides = await this.resolveConnectionOverrides(req);
      const session = this.createSessionState(msg.sessionId as string | undefined, overrides);
      wsSessions.add(session.id);
      wsSend(ws, { type: "session_created", sessionId: session.id });
      this.runAgentWs(session, msg.prompt as string, ws, false);
      return;
    }

    if (msgType === "message") {
      const session = this.sessions.get(msg.sessionId as string);
      if (!session) { wsSend(ws, { type: "error", error: "Session not found" }); return; }
      if (!session.done) { wsSend(ws, { type: "error", error: "Session is still running" }); return; }
      session.done = false;
      session.abortController = new AbortController();
      this.runAgentWs(session, msg.prompt as string, ws, true);
      return;
    }

    if (msgType === "permission_response") {
      const session = this.sessions.get(msg.sessionId as string);
      if (!session?.pendingPermission) return;
      this.clearPendingPermissionTimer(session);
      const { sessionId: _sid, type: _type, ...response } = msg;
      session.pendingPermission.resolve(response as unknown as PermissionResponse);
      session.pendingPermission = null;
      return;
    }

    if (msgType === "input_response") {
      const session = this.sessions.get(msg.sessionId as string);
      if (!session?.pendingInput) return;
      this.clearPendingInputTimer(session);
      session.pendingInput.resolve((msg.answer as string) ?? "");
      session.pendingInput = null;
      return;
    }

    if (msgType === "abort") {
      const session = this.sessions.get(msg.sessionId as string);
      if (session) this.destroySession(session);
    }
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  private createSessionState(
    requestedId: string | undefined,
    overrides: ConnectionOverrides,
  ): SessionState {
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

    this.sessions.set(sessionId, session);
    return session;
  }

  private makeThread(session: SessionState, resume: boolean) {
    const handlers = {
      cwd: session.cwd,
      permissionHandler: (req: import("../permissions/types.js").PermissionRequest) =>
        this.bridgePermission(session.id, req),
      userInputHandler: (q: string) =>
        this.bridgeUserInput(session.id, q),
    };

    return resume
      ? this.code.resumeThread(session.id, handlers)
      : this.code.createThread({ sessionId: session.id, ...handlers });
  }

  private runAgentSse(session: SessionState, prompt: string, resume: boolean): void {
    const run = async () => {
      try {
        const thread = this.makeThread(session, resume);
        for await (const event of thread.run(prompt, { signal: session.abortController.signal })) {
          this.emitSseEvent(session, event);
          session.lastActivity = Date.now();
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          this.emitSseEvent(session, {
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
        const thread = this.makeThread(session, resume);
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

  private emitSseEvent(session: SessionState, event: StreamEvent): void {
    session.sequenceNum++;
    const seq = session.sequenceNum;

    if (session.sseResponse) {
      writeSseEventRaw(session.sseResponse, seq, serializeEvent(event));
    } else {
      // Buffer with cap — drop oldest if full
      if (session.eventBuffer.length >= MAX_EVENT_BUFFER) {
        session.eventBuffer.shift();
      }
      session.eventBuffer.push({ seq, event });
    }
  }

  private bridgePermission(
    sessionId: string,
    _request: import("../permissions/types.js").PermissionRequest,
  ): Promise<PermissionResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error("Session not found"));
    const timeoutMs = this.options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
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

  private bridgeUserInput(sessionId: string, _question: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error("Session not found"));
    const timeoutMs = this.options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
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

  private startSseKeepalive(session: SessionState): void {
    this.clearSseKeepalive(session);
    session.sseKeepaliveTimer = setInterval(() => {
      if (session.sseResponse && !session.sseResponse.destroyed) {
        session.sseResponse.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);
    session.sseKeepaliveTimer.unref();
  }

  private clearSseKeepalive(session: SessionState): void {
    if (session.sseKeepaliveTimer) {
      clearInterval(session.sseKeepaliveTimer);
      session.sseKeepaliveTimer = null;
    }
  }

  private clearPendingPermissionTimer(session: SessionState): void {
    if (session.pendingPermissionTimer) {
      clearTimeout(session.pendingPermissionTimer);
      session.pendingPermissionTimer = null;
    }
  }

  private clearPendingInputTimer(session: SessionState): void {
    if (session.pendingInputTimer) {
      clearTimeout(session.pendingInputTimer);
      session.pendingInputTimer = null;
    }
  }

  private destroySession(session: SessionState): void {
    session.abortController.abort();
    this.clearSseKeepalive(session);
    this.clearPendingPermissionTimer(session);
    this.clearPendingInputTimer(session);
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
    this.sessions.delete(session.id);
  }

  private reapIdleSessions(): void {
    const timeout = this.options.idleTimeoutMs;
    if (!timeout) return;
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastActivity > timeout) {
        this.destroySession(session);
      }
    }
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

/**
 * Serialize a StreamEvent to a JSON-safe object. Error instances are
 * converted to `{ message, name }` since `JSON.stringify(new Error())`
 * produces `{}`.
 */
function serializeEvent(event: StreamEvent): Record<string, unknown> {
  if (event.type === "error") {
    return { type: "error", error: { message: event.error.message, name: event.error.name } };
  }
  if (event.type === "retry_exhausted") {
    return { ...event, error: { message: event.error.message, name: event.error.name } };
  }
  if (event.type === "retry_attempt") {
    return { ...event, error: { message: event.error.message, name: event.error.name } };
  }
  return event as unknown as Record<string, unknown>;
}

function writeSseEventRaw(res: ServerResponse, seq: number, data: Record<string, unknown>): void {
  res.write(`id: ${seq}\ndata: ${JSON.stringify(data)}\n\n`);
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

function wsSend(ws: WsWebSocket, data: unknown): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}
