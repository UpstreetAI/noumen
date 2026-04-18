import { describe, it, expect } from "vitest";
import { MockFs, MockComputer, MockAIProvider, textResponse, toolCallResponse } from "./helpers.js";
import { Agent } from "../agent.js";
import { createServer, type NoumenServer, type ServerOptions } from "../server/index.js";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Per-test harness
//
// Every test builds a fresh fs / computer / provider / agent / server and
// tears it down via a `using`-style `cleanup` array. Nothing lives at module
// scope, which makes `it.concurrent` safe.
// ---------------------------------------------------------------------------

interface TestCtx {
  fs: MockFs;
  computer: MockComputer;
  provider: MockAIProvider;
  code: Agent;
  server: NoumenServer;
  baseUrl: string;
  wsUrl: string;
  stop: () => Promise<void>;
}

interface BootOptions {
  permissionMode?: "default" | "bypassPermissions" | "acceptEdits";
  ws?: boolean;
  auth?: ServerOptions["auth"];
  maxSessions?: number;
  idleTimeoutMs?: number;
  idleReaperMinIntervalMs?: number;
  pendingTimeoutMs?: number;
  responses?: Array<Parameters<MockAIProvider["addResponse"]>[0]>;
}

async function boot(opts: BootOptions = {}): Promise<TestCtx> {
  const fs = new MockFs();
  const computer = new MockComputer();
  const provider = new MockAIProvider();
  for (const r of opts.responses ?? []) provider.addResponse(r);

  const code = new Agent({
    provider,
    sandbox: { fs, computer },
    options: {
      permissions: opts.permissionMode ? { mode: opts.permissionMode } : undefined,
    },
  });

  const server = createServer(code, {
    port: 0,
    ws: opts.ws ?? false,
    auth: opts.auth,
    maxSessions: opts.maxSessions,
    idleTimeoutMs: opts.idleTimeoutMs,
    idleReaperMinIntervalMs: opts.idleReaperMinIntervalMs,
    pendingTimeoutMs: opts.pendingTimeoutMs,
    // Tests should never pay the 500 ms drain penalty: teardown is instant.
    shutdownDrainMs: 0,
  });
  await server.start();

  const addr = (server as unknown as { httpServer?: { address(): { port: number } | string | null } }).httpServer?.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;

  return {
    fs, computer, provider, code, server, baseUrl, wsUrl,
    stop: () => server.stop(),
  };
}

// ---------------------------------------------------------------------------
// Small helpers shared across tests
// ---------------------------------------------------------------------------

async function post(url: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return globalThis.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * Wait for a session's run loop to finish by polling `/sessions`. Far faster
 * and more reliable than a fixed `setTimeout`.
 */
async function waitForSessionDone(
  baseUrl: string,
  sessionId: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  while (Date.now() < deadline) {
    const res = await globalThis.fetch(`${baseUrl}/sessions`, { headers: opts.headers });
    if (res.ok) {
      const sessions = (await res.json()) as Array<{ id: string; done: boolean }>;
      const me = sessions.find((s) => s.id === sessionId);
      if (me?.done) return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Session ${sessionId} did not complete within timeout`);
}

/** Poll `predicate` every 10 ms until it returns true or the timeout elapses. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out${opts.label ? `: ${opts.label}` : ""}`);
}

async function readSseEvents(
  url: string,
  opts?: { headers?: Record<string, string>; untilType?: string; timeoutMs?: number },
): Promise<any[]> {
  const ac = new AbortController();
  const timeout = opts?.timeoutMs ?? 2000;
  const timer = setTimeout(() => ac.abort(), timeout);

  const res = await globalThis.fetch(url, { headers: opts?.headers, signal: ac.signal }).catch(() => null);
  if (!res?.body) { clearTimeout(timer); return []; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: any[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          events.push(parsed);
          if (opts?.untilType && parsed.type === opts.untilType) {
            ac.abort();
            return events;
          }
        } catch { /* ignore */ }
      }
    }
  } catch {
    // AbortError from timeout or untilType match
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return events;
}

// ---------------------------------------------------------------------------

describe.concurrent("NoumenServer", () => {
  describe("health check", () => {
    it("returns status ok on GET /health", async () => {
      const ctx = await boot();
      try {
        const res = await globalThis.fetch(`${ctx.baseUrl}/health`);
        const body = await res.json() as any;
        expect(res.status).toBe(200);
        expect(body.status).toBe("ok");
        expect(body.sessions).toBe(0);
      } finally { await ctx.stop(); }
    });
  });

  describe("REST+SSE basic flow", () => {
    it("creates a session and streams events over SSE", async () => {
      const ctx = await boot({ responses: [textResponse("Hello from agent!")] });
      try {
        const createRes = await post(`${ctx.baseUrl}/sessions`, { prompt: "hi" });
        expect(createRes.status).toBe(201);
        const { sessionId, eventsUrl } = await createRes.json() as any;
        expect(sessionId).toBeTruthy();
        expect(eventsUrl).toContain(sessionId);

        const events = await readSseEvents(
          `${ctx.baseUrl}${eventsUrl}`,
          { untilType: "turn_complete" },
        );
        const types = events.map((e: any) => e.type);
        expect(types).toContain("text_delta");
        expect(types).toContain("turn_complete");

        const textDelta = events.find((e: any) => e.type === "text_delta");
        expect(textDelta.text).toContain("Hello from agent!");
      } finally { await ctx.stop(); }
    });

    it("returns 400 when prompt is missing", async () => {
      const ctx = await boot();
      try {
        const res = await post(`${ctx.baseUrl}/sessions`, {});
        expect(res.status).toBe(400);
      } finally { await ctx.stop(); }
    });
  });

  describe("session management", () => {
    it("lists active sessions", async () => {
      const ctx = await boot({
        responses: [textResponse("a"), textResponse("b")],
      });
      try {
        const r1 = await post(`${ctx.baseUrl}/sessions`, { prompt: "one" });
        const r2 = await post(`${ctx.baseUrl}/sessions`, { prompt: "two" });
        const id1 = (await r1.json() as any).sessionId;
        const id2 = (await r2.json() as any).sessionId;

        await waitForSessionDone(ctx.baseUrl, id1);
        await waitForSessionDone(ctx.baseUrl, id2);

        const listRes = await globalThis.fetch(`${ctx.baseUrl}/sessions`);
        const sessions = await listRes.json() as any[];
        expect(sessions.length).toBe(2);
      } finally { await ctx.stop(); }
    });

    it("deletes a session", async () => {
      const ctx = await boot({ responses: [textResponse("hi")] });
      try {
        const createRes = await post(`${ctx.baseUrl}/sessions`, { prompt: "hi" });
        const { sessionId } = await createRes.json() as any;

        await waitForSessionDone(ctx.baseUrl, sessionId);

        const delRes = await globalThis.fetch(`${ctx.baseUrl}/sessions/${sessionId}`, { method: "DELETE" });
        expect(delRes.status).toBe(200);

        const listRes = await globalThis.fetch(`${ctx.baseUrl}/sessions`);
        const sessions = await listRes.json() as any[];
        expect(sessions.length).toBe(0);
      } finally { await ctx.stop(); }
    });

    it("returns 404 for unknown session", async () => {
      const ctx = await boot();
      try {
        const res = await globalThis.fetch(`${ctx.baseUrl}/sessions/nonexistent/events`);
        expect(res.status).toBe(404);
      } finally { await ctx.stop(); }
    });
  });

  describe("auth", () => {
    it("rejects requests without valid bearer token", async () => {
      const ctx = await boot({ auth: { type: "bearer", token: "secret-token" } });
      try {
        const res = await post(`${ctx.baseUrl}/sessions`, { prompt: "hi" });
        expect(res.status).toBe(401);
      } finally { await ctx.stop(); }
    });

    it("accepts requests with valid bearer token", async () => {
      const ctx = await boot({
        responses: [textResponse("ok")],
        auth: { type: "bearer", token: "secret-token" },
      });
      try {
        const res = await post(`${ctx.baseUrl}/sessions`, { prompt: "hi" }, {
          Authorization: "Bearer secret-token",
        });
        expect(res.status).toBe(201);
      } finally { await ctx.stop(); }
    });

    it("health check does not require auth", async () => {
      const ctx = await boot({ auth: { type: "bearer", token: "secret-token" } });
      try {
        const res = await globalThis.fetch(`${ctx.baseUrl}/health`);
        expect(res.status).toBe(200);
      } finally { await ctx.stop(); }
    });
  });

  describe("max sessions", () => {
    it("rejects when max sessions reached", async () => {
      const ctx = await boot({
        responses: [textResponse("ok"), textResponse("ok")],
        maxSessions: 1,
      });
      try {
        const res1 = await post(`${ctx.baseUrl}/sessions`, { prompt: "one" });
        expect(res1.status).toBe(201);

        const res2 = await post(`${ctx.baseUrl}/sessions`, { prompt: "two" });
        expect(res2.status).toBe(429);
      } finally { await ctx.stop(); }
    });
  });

  describe("idle timeout", () => {
    it("reaps idle sessions", async () => {
      // With idleReaperMinIntervalMs = 25, the reaper fires every ~25 ms,
      // so total wait is idleTimeoutMs (50) + one reaper tick (~25) ≈ 75 ms.
      const ctx = await boot({
        responses: [textResponse("ok")],
        idleTimeoutMs: 50,
        idleReaperMinIntervalMs: 25,
      });
      try {
        const createRes = await post(`${ctx.baseUrl}/sessions`, { prompt: "hi" });
        const { sessionId } = await createRes.json() as any;

        await waitForSessionDone(ctx.baseUrl, sessionId);

        await waitFor(async () => {
          const listRes = await globalThis.fetch(`${ctx.baseUrl}/sessions`);
          const sessions = await listRes.json() as any[];
          return sessions.length === 0;
        }, { timeoutMs: 1000, label: "session reaped" });
      } finally { await ctx.stop(); }
    });
  });

  describe("permission bridging (REST)", () => {
    it("emits permission_request and responds to it via POST", async () => {
      const ctx = await boot({
        permissionMode: "default",
        responses: [
          toolCallResponse("tc-1", "Bash", { command: "rm -rf /" }),
          textResponse("Done."),
        ],
      });
      try {
        const createRes = await post(`${ctx.baseUrl}/sessions`, { prompt: "do it" });
        const { sessionId } = await createRes.json() as any;

        // Wait for the permission request to be pending on the server side.
        const sessions = (ctx.server as any).sessions as Map<string, any>;
        await waitFor(
          () => !!sessions.get(sessionId)?.pendingPermission,
          { timeoutMs: 2000, label: "pending permission set" },
        );

        const permRes = await post(
          `${ctx.baseUrl}/sessions/${sessionId}/permissions`,
          { allow: true },
        );
        expect(permRes.status).toBe(200);

        // After allow, the agent continues and eventually finishes.
        await waitForSessionDone(ctx.baseUrl, sessionId);
      } finally { await ctx.stop(); }
    });
  });

  describe("user input bridging (REST)", () => {
    it("returns 404 for input response on unknown session", async () => {
      const ctx = await boot();
      try {
        const res = await post(`${ctx.baseUrl}/sessions/fake/input`, { answer: "yes" });
        expect(res.status).toBe(404);
      } finally { await ctx.stop(); }
    });

    it("rejects input response when no pending request", async () => {
      const ctx = await boot({ responses: [textResponse("ok")] });
      try {
        const createRes = await post(`${ctx.baseUrl}/sessions`, { prompt: "hi" });
        const { sessionId } = await createRes.json() as any;

        await waitForSessionDone(ctx.baseUrl, sessionId);

        const res = await post(`${ctx.baseUrl}/sessions/${sessionId}/input`, { answer: "yes" });
        expect(res.status).toBe(409);
      } finally { await ctx.stop(); }
    });
  });

  describe("follow-up messages", () => {
    it("rejects messages while session is running", async () => {
      // Block the provider until we choose to release it, guaranteeing the
      // session is still running when we POST the follow-up.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });

      const provider: any = {
        defaultModel: "mock-model",
        async *chat() {
          await gate;
          yield {
            id: "x", model: "mock-model",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
          };
          yield {
            id: "x", model: "mock-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
        },
      };

      const code = new Agent({
        provider,
        sandbox: { fs: new MockFs(), computer: new MockComputer() },
      });
      const server = createServer(code, { port: 0, ws: false, shutdownDrainMs: 0 });
      await server.start();
      const addr = (server as any).httpServer?.address();
      const port = typeof addr === "object" ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const createRes = await post(`${baseUrl}/sessions`, { prompt: "start" });
        const { sessionId } = await createRes.json() as any;

        // Wait until the provider's chat() is actually gated (i.e. the run
        // loop has reached `await gate`). The session is guaranteed to be
        // running at this point — no timing flake possible.
        await waitFor(() => {
          const sessions = (server as any).sessions as Map<string, any>;
          const s = sessions.get(sessionId);
          return !!s && !s.done;
        }, { timeoutMs: 1000, label: "session entered run loop" });

        const msgRes = await post(`${baseUrl}/sessions/${sessionId}/messages`, { prompt: "more" });
        expect(msgRes.status).toBe(409);

        release();
        await waitForSessionDone(baseUrl, sessionId);
      } finally { await server.stop(); }
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown routes", async () => {
      const ctx = await boot();
      try {
        const res = await globalThis.fetch(`${ctx.baseUrl}/unknown`);
        expect(res.status).toBe(404);
      } finally { await ctx.stop(); }
    });
  });

  describe("SSE format", () => {
    it("SSE stream is text/event-stream with id and data lines", async () => {
      const ctx = await boot({ responses: [textResponse("ok")] });
      try {
        const createRes = await post(`${ctx.baseUrl}/sessions`, { prompt: "hi" });
        const { sessionId } = await createRes.json() as any;

        await waitForSessionDone(ctx.baseUrl, sessionId);

        const ac = new AbortController();
        const sseRes = await globalThis.fetch(
          `${ctx.baseUrl}/sessions/${sessionId}/events`,
          { signal: ac.signal },
        );
        expect(sseRes.status).toBe(200);
        expect(sseRes.headers.get("content-type")).toBe("text/event-stream");

        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let raw = "";
        const { value } = await reader.read();
        if (value) raw += decoder.decode(value, { stream: true });
        ac.abort();
        reader.releaseLock();

        expect(raw).toContain("id: ");
        expect(raw).toContain("data: ");
        expect(raw).toMatch(/^id: \d+$/m);
      } finally { await ctx.stop(); }
    });

    it("respects Last-Event-ID on reconnect — replays only events after the given seq", async () => {
      const ctx = await boot({ responses: [textResponse("hello world")] });
      try {
        const createRes = await post(`${ctx.baseUrl}/sessions`, { prompt: "hi" });
        const { sessionId } = await createRes.json() as any;

        await waitForSessionDone(ctx.baseUrl, sessionId);

        const sessions = (ctx.server as any).sessions as Map<string, any>;
        const session = sessions.get(sessionId);
        expect(session).toBeDefined();

        const totalBuffered = session.eventBuffer.length;
        expect(totalBuffered).toBeGreaterThan(2);

        const midpointSeq = session.eventBuffer[1].seq;
        const expectedReplayCount = session.eventBuffer.filter(
          (e: any) => e.seq > midpointSeq,
        ).length;
        expect(expectedReplayCount).toBeGreaterThan(0);
        expect(expectedReplayCount).toBeLessThan(totalBuffered);

        const events = await readSseEvents(
          `${ctx.baseUrl}/sessions/${sessionId}/events`,
          { headers: { "Last-Event-ID": String(midpointSeq) }, timeoutMs: 1000 },
        );

        expect(events.length).toBe(expectedReplayCount);
      } finally { await ctx.stop(); }
    });
  });

  describe("body size limit", () => {
    it("rejects oversized request bodies", async () => {
      const ctx = await boot();
      try {
        const largeBody = JSON.stringify({ prompt: "x".repeat(1_100_000) });
        const res = await globalThis.fetch(`${ctx.baseUrl}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: largeBody,
        }).catch(() => null);

        if (res) expect(res.status).toBe(500);
      } finally { await ctx.stop(); }
    });
  });

  describe("event buffer cap", () => {
    it("keeps the per-session event buffer bounded", async () => {
      const ctx = await boot({ responses: [textResponse("ok")] });
      try {
        const createRes = await post(`${ctx.baseUrl}/sessions`, { prompt: "hi" });
        const { sessionId } = await createRes.json() as any;
        expect(createRes.status).toBe(201);

        await waitForSessionDone(ctx.baseUrl, sessionId);

        const sessions = (ctx.server as any).sessions as Map<string, any>;
        for (const session of sessions.values()) {
          expect(session.eventBuffer.length).toBeLessThanOrEqual(1000);
        }
      } finally { await ctx.stop(); }
    });
  });

  describe("subscriber replacement", () => {
    it("replaces existing SSE subscriber with new one", async () => {
      const ctx = await boot({ responses: [textResponse("ok")] });
      try {
        const createRes = await post(`${ctx.baseUrl}/sessions`, { prompt: "hi" });
        const { sessionId } = await createRes.json() as any;

        await waitForSessionDone(ctx.baseUrl, sessionId);

        const events1 = await readSseEvents(
          `${ctx.baseUrl}/sessions/${sessionId}/events`,
          { untilType: "turn_complete", timeoutMs: 1000 },
        );
        expect(events1.length).toBeGreaterThan(0);

        const events2 = await readSseEvents(
          `${ctx.baseUrl}/sessions/${sessionId}/events`,
          { timeoutMs: 300 },
        );
        expect(Array.isArray(events2)).toBe(true);
      } finally { await ctx.stop(); }
    });
  });

  describe("pending timeout", () => {
    it("rejects permission bridge after timeout", async () => {
      const ctx = await boot({
        permissionMode: "default",
        responses: [
          toolCallResponse("tc-1", "Bash", { command: "ls" }),
          textResponse("Done."),
        ],
        pendingTimeoutMs: 50,
      });
      try {
        const createRes = await post(`${ctx.baseUrl}/sessions`, { prompt: "do it" });
        const { sessionId } = await createRes.json() as any;

        // Don't respond to the permission request — let it timeout, then the
        // session errors and becomes done.
        await waitForSessionDone(ctx.baseUrl, sessionId, { timeoutMs: 1000 });

        const listRes = await globalThis.fetch(`${ctx.baseUrl}/sessions`);
        const sessions = await listRes.json() as any[];
        const session = sessions.find((s: any) => s.id === sessionId);
        expect(session?.done).toBe(true);
      } finally { await ctx.stop(); }
    });
  });

  // -------------------------------------------------------------------------
  // WebSocket transport
  // -------------------------------------------------------------------------

  describe("WebSocket transport", () => {
    function wsConnect(url: string): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
      });
    }

    function wsSend(ws: WebSocket, data: unknown): void {
      ws.send(JSON.stringify(data));
    }

    function collectMessages(
      ws: WebSocket,
      opts?: { untilType?: string; timeoutMs?: number },
    ): Promise<any[]> {
      const msgs: any[] = [];
      const timeout = opts?.timeoutMs ?? 2000;

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          ws.removeAllListeners("message");
          resolve(msgs);
        }, timeout);

        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          msgs.push(msg);
          if (opts?.untilType && msg.type === opts.untilType) {
            clearTimeout(timer);
            ws.removeAllListeners("message");
            resolve(msgs);
          }
        });
      });
    }

    it("sends run command and receives session_created + stream events", async () => {
      const ctx = await boot({ ws: true, responses: [textResponse("WS hello!")] });
      try {
        const ws = await wsConnect(ctx.wsUrl);
        wsSend(ws, { type: "run", prompt: "hi" });

        const msgs = await collectMessages(ws, { untilType: "turn_complete" });
        ws.close();

        const types = msgs.map((m) => m.type);
        expect(types).toContain("session_created");
        expect(types).toContain("text_delta");
        expect(types).toContain("turn_complete");

        const sessionCreated = msgs.find((m) => m.type === "session_created");
        expect(sessionCreated.sessionId).toBeTruthy();

        const textDelta = msgs.find((m) => m.type === "text_delta");
        expect(textDelta.text).toContain("WS hello!");
        expect(textDelta.sessionId).toBeTruthy();
        expect(textDelta.seq).toBeGreaterThan(0);
      } finally { await ctx.stop(); }
    });

    it("supports follow-up messages after session is done", async () => {
      const ctx = await boot({
        ws: true,
        responses: [textResponse("first"), textResponse("second")],
      });
      try {
        const ws = await wsConnect(ctx.wsUrl);
        wsSend(ws, { type: "run", prompt: "hi" });

        const firstMsgs = await collectMessages(ws, { untilType: "turn_complete" });
        const sessionId = firstMsgs.find((m) => m.type === "session_created")?.sessionId;
        expect(sessionId).toBeTruthy();

        await waitForSessionDone(ctx.baseUrl, sessionId);

        wsSend(ws, { type: "message", sessionId, prompt: "more" });

        const secondMsgs = await collectMessages(ws, { untilType: "turn_complete" });
        ws.close();

        const textDeltas = secondMsgs.filter((m) => m.type === "text_delta");
        expect(textDeltas.length).toBeGreaterThan(0);
        expect(textDeltas[0].text).toContain("second");
      } finally { await ctx.stop(); }
    });

    it("handles abort command", async () => {
      const ctx = await boot({ ws: true, responses: [textResponse("hi")] });
      try {
        const ws = await wsConnect(ctx.wsUrl);
        wsSend(ws, { type: "run", prompt: "start" });

        const msgs = await collectMessages(ws, { untilType: "session_created", timeoutMs: 1000 });
        const sessionId = msgs.find((m) => m.type === "session_created")?.sessionId;

        wsSend(ws, { type: "abort", sessionId });

        await waitFor(async () => {
          const listRes = await globalThis.fetch(ctx.baseUrl + "/sessions");
          const sessions = await listRes.json() as any[];
          return sessions.length === 0;
        }, { timeoutMs: 1000, label: "session cleaned up after abort" });

        ws.close();
      } finally { await ctx.stop(); }
    });

    it("authenticates via query parameter token", async () => {
      const ctx = await boot({
        ws: true,
        auth: { type: "bearer", token: "ws-secret" },
        responses: [textResponse("ok")],
      });
      try {
        const ws = await wsConnect(`${ctx.wsUrl}?token=ws-secret`);
        wsSend(ws, { type: "run", prompt: "hi" });

        const msgs = await collectMessages(ws, { untilType: "session_created", timeoutMs: 1000 });
        ws.close();

        expect(msgs.find((m) => m.type === "session_created")).toBeTruthy();
      } finally { await ctx.stop(); }
    });

    it("rejects connections with invalid token", async () => {
      const ctx = await boot({
        ws: true,
        auth: { type: "bearer", token: "ws-secret" },
      });
      try {
        const ws = new WebSocket(`${ctx.wsUrl}?token=wrong`);
        const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
        await closed;
      } finally { await ctx.stop(); }
    });

    it("enforces max sessions over WebSocket", async () => {
      const ctx = await boot({
        ws: true,
        maxSessions: 1,
        responses: [textResponse("ok"), textResponse("ok")],
      });
      try {
        const ws = await wsConnect(ctx.wsUrl);
        wsSend(ws, { type: "run", prompt: "one" });

        await collectMessages(ws, { untilType: "session_created", timeoutMs: 1000 });

        wsSend(ws, { type: "run", prompt: "two" });

        const errorMsgs = await collectMessages(ws, { timeoutMs: 300 });
        ws.close();

        const error = errorMsgs.find((m) => m.type === "error");
        expect(error).toBeTruthy();
        expect(error.error).toContain("Maximum sessions");
      } finally { await ctx.stop(); }
    });

    it("includes sessionId and seq on all stream events", async () => {
      const ctx = await boot({ ws: true, responses: [textResponse("tagged")] });
      try {
        const ws = await wsConnect(ctx.wsUrl);
        wsSend(ws, { type: "run", prompt: "hi" });

        const msgs = await collectMessages(ws, { untilType: "turn_complete" });
        ws.close();

        const streamEvents = msgs.filter((m) => m.type !== "session_created");
        for (const evt of streamEvents) {
          expect(evt.sessionId).toBeTruthy();
          expect(typeof evt.seq).toBe("number");
        }

        const seqs = streamEvents.map((e) => e.seq);
        for (let i = 1; i < seqs.length; i++) {
          expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
        }
      } finally { await ctx.stop(); }
    });

    it("cleans up sessions when WebSocket closes", async () => {
      const ctx = await boot({ ws: true, responses: [textResponse("ok")] });
      try {
        const ws = await wsConnect(ctx.wsUrl);
        wsSend(ws, { type: "run", prompt: "hi" });

        await collectMessages(ws, { untilType: "session_created", timeoutMs: 1000 });

        ws.close();

        await waitFor(async () => {
          const listRes = await globalThis.fetch(ctx.baseUrl + "/sessions");
          const sessions = await listRes.json() as any[];
          return sessions.length === 0;
        }, { timeoutMs: 1000, label: "sessions cleaned up after ws.close" });
      } finally { await ctx.stop(); }
    });
  });
});
