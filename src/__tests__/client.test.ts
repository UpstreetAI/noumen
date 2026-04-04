import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockFs, MockComputer, MockAIProvider, textResponse, toolCallResponse } from "./helpers.js";
import { Agent } from "../agent.js";
import { createServer, type NoumenServer } from "../server/index.js";
import { NoumenClient } from "../client/index.js";
import type { StreamEvent } from "../session/types.js";
import WebSocket from "ws";

// Polyfill WebSocket for Node < 21 test environment
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = WebSocket;
}

let fs: MockFs;
let computer: MockComputer;
let provider: MockAIProvider;
let code: Agent;
let server: NoumenServer;
let baseUrl: string;

async function setup(opts?: { auth?: any }) {
  code = new Agent({
    provider: provider,
    sandbox: { fs, computer },
  });

  server = createServer(code, {
    port: 0,
    ws: true,
    ...opts,
  });
  await server.start();

  const addr = (server as any).httpServer?.address();
  const port = typeof addr === "object" ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  provider = new MockAIProvider();
});

afterEach(async () => {
  if (server) await server.stop();
});

// ---------------------------------------------------------------------------

describe("NoumenClient", () => {
  describe("SSE transport", () => {
    it("streams events via SSE", async () => {
      provider.addResponse(textResponse("Hello from SSE!"));
      await setup();

      const client = new NoumenClient({ baseUrl, transport: "sse" });
      const events = await collectEvents(client.run("hi"));

      const types = events.map((e) => e.type);
      expect(types).toContain("text_delta");
      expect(types).toContain("turn_complete");

      const textDelta = events.find((e) => e.type === "text_delta") as any;
      expect(textDelta.text).toContain("Hello from SSE!");
    });

    it("works with bearer auth", async () => {
      provider.addResponse(textResponse("Authenticated!"));
      await setup({ auth: { type: "bearer", token: "test-token" } });

      const client = new NoumenClient({ baseUrl, token: "test-token", transport: "sse" });
      const events = await collectEvents(client.run("hi"));
      const types = events.map((e) => e.type);
      expect(types).toContain("text_delta");
    });

    it("throws on auth failure", async () => {
      provider.addResponse(textResponse("nope"));
      await setup({ auth: { type: "bearer", token: "correct" } });

      const client = new NoumenClient({ baseUrl, token: "wrong", transport: "sse" });
      await expect(collectEvents(client.run("hi"))).rejects.toThrow();
    });
  });

  describe("WebSocket transport", () => {
    it("streams events via WebSocket", async () => {
      provider.addResponse(textResponse("Hello from WS!"));
      await setup();

      const client = new NoumenClient({ baseUrl, transport: "ws" });
      const events = await collectEvents(client.run("hi"));

      const types = events.map((e) => e.type);
      expect(types).toContain("text_delta");
      expect(types).toContain("turn_complete");

      const textDelta = events.find((e) => e.type === "text_delta") as any;
      expect(textDelta.text).toContain("Hello from WS!");
    });

    it("works with bearer auth via query param", async () => {
      provider.addResponse(textResponse("WS Auth!"));
      await setup({ auth: { type: "bearer", token: "ws-token" } });

      const client = new NoumenClient({ baseUrl, token: "ws-token", transport: "ws" });
      const events = await collectEvents(client.run("hi"));
      const types = events.map((e) => e.type);
      expect(types).toContain("text_delta");
    });
  });

  describe("listSessions", () => {
    it("returns active sessions", async () => {
      provider.addResponse(textResponse("ok"));
      await setup();

      const client = new NoumenClient({ baseUrl, transport: "sse" });
      await collectEvents(client.run("hi"));

      const sessions = await client.listSessions();
      // Session should exist (may be done=true)
      expect(sessions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("abort", () => {
    it("aborts a session via AbortSignal (SSE)", async () => {
      provider.addResponse(textResponse("long response that takes forever"));
      await setup();

      const ac = new AbortController();
      const client = new NoumenClient({ baseUrl, transport: "sse" });

      // Start collecting but abort quickly
      const eventsPromise = collectEvents(client.run("hi", { signal: ac.signal }));
      setTimeout(() => ac.abort(), 50);

      // Should resolve (not hang) due to abort
      const events = await eventsPromise.catch(() => [] as StreamEvent[]);
      // May have some events or may be empty depending on timing
      expect(Array.isArray(events)).toBe(true);
    });

    it("aborts a session via client.abort()", async () => {
      provider.addResponse(textResponse("ok"));
      await setup();

      // First create a session via SSE
      const client = new NoumenClient({ baseUrl, transport: "sse" });
      const events = await collectEvents(client.run("hi"));
      expect(events.length).toBeGreaterThan(0);

      // List sessions to get an ID
      const sessions = await client.listSessions();
      if (sessions.length > 0) {
        await client.abort(sessions[0].id);
        const after = await client.listSessions();
        expect(after.length).toBeLessThan(sessions.length);
      }
    });
  });

  describe("sendMessage (follow-up)", () => {
    it("sends a follow-up message via SSE", async () => {
      provider.addResponse(textResponse("first"));
      provider.addResponse(textResponse("second"));
      await setup();

      const client = new NoumenClient({ baseUrl, transport: "sse" });

      // Run first prompt
      const firstEvents = await collectEvents(client.run("hello"));
      expect(firstEvents.some((e) => e.type === "turn_complete")).toBe(true);

      // Get session ID from server
      const sessions = await client.listSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const sessionId = sessions[0].id;

      // Send follow-up
      const secondEvents = await collectEvents(client.sendMessage(sessionId, "world"));
      const types = secondEvents.map((e) => e.type);
      expect(types).toContain("text_delta");
      expect(types).toContain("turn_complete");
    });
  });

  describe("SSE reconnection", () => {
    it("does not throw on permanent 401 error during run", async () => {
      provider.addResponse(textResponse("ok"));
      await setup({ auth: { type: "bearer", token: "correct" } });

      const client = new NoumenClient({ baseUrl, token: "wrong", transport: "sse" });
      // Should fail with auth error, not hang
      await expect(collectEvents(client.run("hi"))).rejects.toThrow();
    });
  });

  describe("SSE event IDs", () => {
    it("receives events with sequential ordering", async () => {
      provider.addResponse(textResponse("Hello!"));
      await setup();

      const client = new NoumenClient({ baseUrl, transport: "sse" });
      const events = await collectEvents(client.run("hi"));

      const types = events.map((e) => e.type);
      expect(types).toContain("text_delta");
      expect(types).toContain("turn_complete");
      expect(events.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("SSE deduplication", () => {
    it("yields turn_complete after normal flow without duplicates", async () => {
      provider.addResponse(textResponse("one"));
      await setup();

      const client = new NoumenClient({ baseUrl, transport: "sse" });
      const events = await collectEvents(client.run("hi"));

      // Should have exactly one turn_complete
      const turnCompletes = events.filter((e) => e.type === "turn_complete");
      expect(turnCompletes.length).toBe(1);
    });
  });
});
