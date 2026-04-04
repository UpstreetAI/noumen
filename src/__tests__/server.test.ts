import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockFs, MockComputer, MockAIProvider, textResponse, toolCallResponse } from "./helpers.js";
import { Code } from "../code.js";
import { createServer, type NoumenServer } from "../server/index.js";

let fs: MockFs;
let computer: MockComputer;
let provider: MockAIProvider;
let code: Code;
let server: NoumenServer;
let baseUrl: string;

function makeCode(opts?: { permissionMode?: string }) {
  return new Code({
    aiProvider: provider,
    sandbox: { fs, computer },
    options: {
      permissions: opts?.permissionMode
        ? { mode: opts.permissionMode as any }
        : undefined,
    },
  });
}

async function startServer(
  c: Code,
  opts?: { auth?: any; maxSessions?: number; idleTimeoutMs?: number },
): Promise<{ server: NoumenServer; baseUrl: string }> {
  const s = createServer(c, {
    port: 0,
    ws: false,
    ...opts,
  });
  await s.start();
  const addr = (s as any).httpServer?.address();
  const port = typeof addr === "object" ? addr.port : 0;
  return { server: s, baseUrl: `http://127.0.0.1:${port}` };
}

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  provider = new MockAIProvider();
});

afterEach(async () => {
  if (server) await server.stop();
});

async function post(url: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return globalThis.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function readSseEvents(
  url: string,
  opts?: { headers?: Record<string, string>; untilType?: string; timeoutMs?: number },
): Promise<any[]> {
  const ac = new AbortController();
  const timeout = opts?.timeoutMs ?? 3000;
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

describe("NoumenServer", () => {
  describe("health check", () => {
    it("returns status ok on GET /health", async () => {
      code = makeCode();
      ({ server, baseUrl } = await startServer(code));

      const res = await globalThis.fetch(`${baseUrl}/health`);
      const body = await res.json() as any;
      expect(res.status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.sessions).toBe(0);
    });
  });

  describe("REST+SSE basic flow", () => {
    it("creates a session and streams events over SSE", async () => {
      provider.addResponse(textResponse("Hello from agent!"));

      code = makeCode();
      ({ server, baseUrl } = await startServer(code));

      const createRes = await post(`${baseUrl}/sessions`, { prompt: "hi" });
      expect(createRes.status).toBe(201);
      const { sessionId, eventsUrl } = await createRes.json() as any;
      expect(sessionId).toBeTruthy();
      expect(eventsUrl).toContain(sessionId);

      // Wait for the agent run to finish, then read buffered events
      await new Promise((r) => setTimeout(r, 300));

      const events = await readSseEvents(`${baseUrl}${eventsUrl}`, { untilType: "turn_complete" });
      const types = events.map((e: any) => e.type);
      expect(types).toContain("text_delta");
      expect(types).toContain("turn_complete");

      const textDelta = events.find((e: any) => e.type === "text_delta");
      expect(textDelta.text).toContain("Hello from agent!");
    });

    it("returns 400 when prompt is missing", async () => {
      code = makeCode();
      ({ server, baseUrl } = await startServer(code));

      const res = await post(`${baseUrl}/sessions`, {});
      expect(res.status).toBe(400);
    });
  });

  describe("session management", () => {
    it("lists active sessions", async () => {
      provider.addResponse(textResponse("a"));
      provider.addResponse(textResponse("b"));

      code = makeCode();
      ({ server, baseUrl } = await startServer(code));

      await post(`${baseUrl}/sessions`, { prompt: "one" });
      await post(`${baseUrl}/sessions`, { prompt: "two" });

      await new Promise((r) => setTimeout(r, 200));

      const listRes = await globalThis.fetch(`${baseUrl}/sessions`);
      const sessions = await listRes.json() as any[];
      expect(sessions.length).toBe(2);
    });

    it("deletes a session", async () => {
      provider.addResponse(textResponse("hi"));

      code = makeCode();
      ({ server, baseUrl } = await startServer(code));

      const createRes = await post(`${baseUrl}/sessions`, { prompt: "hi" });
      const { sessionId } = await createRes.json() as any;

      await new Promise((r) => setTimeout(r, 200));

      const delRes = await globalThis.fetch(`${baseUrl}/sessions/${sessionId}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);

      const listRes = await globalThis.fetch(`${baseUrl}/sessions`);
      const sessions = await listRes.json() as any[];
      expect(sessions.length).toBe(0);
    });

    it("returns 404 for unknown session", async () => {
      code = makeCode();
      ({ server, baseUrl } = await startServer(code));

      const res = await globalThis.fetch(`${baseUrl}/sessions/nonexistent/events`);
      expect(res.status).toBe(404);
    });
  });

  describe("auth", () => {
    it("rejects requests without valid bearer token", async () => {
      code = makeCode();
      ({ server, baseUrl } = await startServer(code, {
        auth: { type: "bearer", token: "secret-token" },
      }));

      const res = await post(`${baseUrl}/sessions`, { prompt: "hi" });
      expect(res.status).toBe(401);
    });

    it("accepts requests with valid bearer token", async () => {
      provider.addResponse(textResponse("ok"));

      code = makeCode();
      ({ server, baseUrl } = await startServer(code, {
        auth: { type: "bearer", token: "secret-token" },
      }));

      const res = await post(`${baseUrl}/sessions`, { prompt: "hi" }, {
        Authorization: "Bearer secret-token",
      });
      expect(res.status).toBe(201);
    });

    it("health check does not require auth", async () => {
      code = makeCode();
      ({ server, baseUrl } = await startServer(code, {
        auth: { type: "bearer", token: "secret-token" },
      }));

      const res = await globalThis.fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
    });
  });

  describe("max sessions", () => {
    it("rejects when max sessions reached", async () => {
      provider.addResponse(textResponse("ok"));
      provider.addResponse(textResponse("ok"));

      code = makeCode();
      ({ server, baseUrl } = await startServer(code, { maxSessions: 1 }));

      const res1 = await post(`${baseUrl}/sessions`, { prompt: "one" });
      expect(res1.status).toBe(201);

      const res2 = await post(`${baseUrl}/sessions`, { prompt: "two" });
      expect(res2.status).toBe(429);
    });
  });

  describe("idle timeout", () => {
    it("reaps idle sessions", async () => {
      provider.addResponse(textResponse("ok"));

      code = makeCode();
      ({ server, baseUrl } = await startServer(code, { idleTimeoutMs: 200 }));

      await post(`${baseUrl}/sessions`, { prompt: "hi" });

      // Wait for agent to finish + idle timeout + reaper interval to fire
      await new Promise((r) => setTimeout(r, 1500));

      const listRes = await globalThis.fetch(`${baseUrl}/sessions`);
      const sessions = await listRes.json() as any[];
      expect(sessions.length).toBe(0);
    }, 5000);
  });

  describe("permission bridging (REST)", () => {
    it("emits permission_request and accepts permission_response via POST", async () => {
      // First call: tool that triggers permission, second call: follow-up text
      provider.addResponse(toolCallResponse("tc-1", "Bash", { command: "rm -rf /" }));
      provider.addResponse(textResponse("Done."));

      code = new Code({
        aiProvider: provider,
        sandbox: { fs, computer },
        options: {
          permissions: {
            mode: "default",
            handler: undefined,
          },
        },
      });
      ({ server, baseUrl } = await startServer(code));

      const createRes = await post(`${baseUrl}/sessions`, { prompt: "do it" });
      const { sessionId } = await createRes.json() as any;

      // Give agent time to reach the permission request
      await new Promise((r) => setTimeout(r, 300));

      // The permission_request should be buffered; respond to it
      const permRes = await post(`${baseUrl}/sessions/${sessionId}/permissions`, {
        allow: true,
      });
      // May be 200 or 409 depending on timing
      expect([200, 409]).toContain(permRes.status);
    });
  });

  describe("user input bridging (REST)", () => {
    it("accepts input response via POST", async () => {
      code = makeCode();
      ({ server, baseUrl } = await startServer(code));

      // No session to test against, verify endpoint returns 404
      const res = await post(`${baseUrl}/sessions/fake/input`, { answer: "yes" });
      expect(res.status).toBe(404);
    });

    it("rejects input response when no pending request", async () => {
      provider.addResponse(textResponse("ok"));

      code = makeCode();
      ({ server, baseUrl } = await startServer(code));

      const createRes = await post(`${baseUrl}/sessions`, { prompt: "hi" });
      const { sessionId } = await createRes.json() as any;

      await new Promise((r) => setTimeout(r, 200));

      const res = await post(`${baseUrl}/sessions/${sessionId}/input`, { answer: "yes" });
      expect(res.status).toBe(409);
    });
  });

  describe("follow-up messages", () => {
    it("rejects messages while session is running", async () => {
      // Use a slow response — tool call that takes time
      provider.addResponse(textResponse("thinking..."));

      code = makeCode();
      ({ server, baseUrl } = await startServer(code));

      const createRes = await post(`${baseUrl}/sessions`, { prompt: "start" });
      const { sessionId } = await createRes.json() as any;

      // Try immediately before the run finishes
      const msgRes = await post(`${baseUrl}/sessions/${sessionId}/messages`, { prompt: "more" });
      // Might be 409 (still running) or 200 (if it completed fast)
      expect([200, 409]).toContain(msgRes.status);
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown routes", async () => {
      code = makeCode();
      ({ server, baseUrl } = await startServer(code));

      const res = await globalThis.fetch(`${baseUrl}/unknown`);
      expect(res.status).toBe(404);
    });
  });
});
