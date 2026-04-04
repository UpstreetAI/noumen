import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Code } from "../code.js";
import type { StreamEvent } from "../session/types.js";
import type { PermissionResponse } from "../permissions/types.js";

type MaybePromise<T> = T | Promise<T>;

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

interface SessionState {
  id: string;
  abortController: AbortController;
  pendingPermission: PromiseResolver<PermissionResponse> | null;
  pendingInput: PromiseResolver<string> | null;
  lastActivity: number;
  sseResponse: ServerResponse | null;
  eventBuffer: StreamEvent[];
  done: boolean;
  cwd?: string;
}

type WsWebSocket = {
  on(event: "message", cb: (data: Buffer | string) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string): void;
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
  private code: Code;
  private options: ServerOptions;
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private wss: WsServer | null = null;
  private sessions = new Map<string, SessionState>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(code: Code, options: ServerOptions) {
    this.code = code;
    this.options = options;
  }

  async start(): Promise<void> {
    this.httpServer = createHttpServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
        if (!res.headersSent) jsonResponse(res, 500, { error: "Internal server error" });
      });
    });

    if (this.options.ws !== false) {
      await this.initWebSocket();
    }

    if (this.options.idleTimeoutMs) {
      const interval = Math.max(this.options.idleTimeoutMs / 2, 1000);
      this.idleTimer = setInterval(() => this.reapIdleSessions(), interval);
      this.idleTimer.unref();
    }

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

    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }

    if (this.httpServer) {
      // Force-close all open connections so close() doesn't hang
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

  // -------------------------------------------------------------------------
  // HTTP routing
  // -------------------------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

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

      if (sub === "events" && method === "GET") return this.handleSseStream(sessionId, res);
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

    this.runAgentSse(session, prompt);

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

  private handleSseStream(sessionId: string, res: ServerResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session) return jsonResponse(res, 404, { error: "Session not found" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    for (const event of session.eventBuffer) {
      writeSseEvent(res, event);
    }
    session.eventBuffer = [];
    session.sseResponse = res;

    res.on("close", () => {
      if (session.sseResponse === res) session.sseResponse = null;
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

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        await this.handleWsMessage(ws, msg, wsSessions, req);
      } catch (err) {
        wsSend(ws, { type: "error", error: String(err) });
      }
    });

    ws.on("close", () => {
      for (const sid of wsSessions) {
        const session = this.sessions.get(sid);
        if (session) this.destroySession(session);
      }
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
      const { sessionId: _sid, type: _type, ...response } = msg;
      session.pendingPermission.resolve(response as unknown as PermissionResponse);
      session.pendingPermission = null;
      return;
    }

    if (msgType === "input_response") {
      const session = this.sessions.get(msg.sessionId as string);
      if (!session?.pendingInput) return;
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
    const permissionHandler = (request: import("../permissions/types.js").PermissionRequest) =>
      this.bridgePermission(sessionId, request);
    const userInputHandler = (question: string) =>
      this.bridgeUserInput(sessionId, question);

    const thread = this.code.createThread({
      sessionId: requestedId,
      cwd: overrides.cwd,
      permissionHandler,
      userInputHandler,
    });

    const sessionId = thread.sessionId;

    const session: SessionState = {
      id: sessionId,
      abortController: new AbortController(),
      pendingPermission: null,
      pendingInput: null,
      lastActivity: Date.now(),
      sseResponse: null,
      eventBuffer: [],
      done: false,
      cwd: overrides.cwd,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  private makeThread(session: SessionState, resume: boolean) {
    return resume
      ? this.code.resumeThread(session.id, {
          cwd: session.cwd,
          permissionHandler: (req) => this.bridgePermission(session.id, req),
          userInputHandler: (q) => this.bridgeUserInput(session.id, q),
        })
      : this.code.createThread({
          sessionId: session.id,
          cwd: session.cwd,
          permissionHandler: (req) => this.bridgePermission(session.id, req),
          userInputHandler: (q) => this.bridgeUserInput(session.id, q),
        });
  }

  private runAgentSse(session: SessionState, prompt: string, resume = false): void {
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
          wsSend(ws, { ...event, sessionId: session.id });
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
    if (session.sseResponse) {
      writeSseEvent(session.sseResponse, event);
    } else {
      session.eventBuffer.push(event);
    }
  }

  private bridgePermission(
    sessionId: string,
    _request: import("../permissions/types.js").PermissionRequest,
  ): Promise<PermissionResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error("Session not found"));
    return new Promise<PermissionResponse>((resolve, reject) => {
      session.pendingPermission = { resolve, reject };
    });
  }

  private bridgeUserInput(sessionId: string, _question: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error("Session not found"));
    return new Promise<string>((resolve, reject) => {
      session.pendingInput = { resolve, reject };
    });
  }

  private destroySession(session: SessionState): void {
    session.abortController.abort();
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

export function createServer(code: Code, options: ServerOptions): NoumenServer {
  return new NoumenServer(code, options);
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

function writeSseEvent(res: ServerResponse, event: StreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function wsSend(ws: WsWebSocket, data: unknown): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}
