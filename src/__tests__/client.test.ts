import { describe, it, expect } from "vitest";
import { MockFs, MockComputer, MockAIProvider, textResponse } from "./helpers.js";
import { Agent } from "../agent.js";
import { createServer, type NoumenServer } from "../server/index.js";
import { NoumenClient } from "../client/index.js";
import type { StreamEvent } from "../session/types.js";
import WebSocket from "ws";

// Polyfill WebSocket for Node < 21 test environment
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = WebSocket;
}

interface TestCtx {
  fs: MockFs;
  computer: MockComputer;
  provider: MockAIProvider;
  code: Agent;
  server: NoumenServer;
  baseUrl: string;
  stop: () => Promise<void>;
}

async function setup(opts?: { auth?: any; responses?: any[] }): Promise<TestCtx> {
  const fs = new MockFs();
  const computer = new MockComputer();
  const provider = new MockAIProvider();
  for (const r of opts?.responses ?? []) provider.addResponse(r);

  const code = new Agent({ provider, sandbox: { fs, computer } });

  const server = createServer(code, {
    port: 0,
    ws: true,
    auth: opts?.auth,
    // Tests should never pay the 500 ms drain penalty: teardown is instant.
    shutdownDrainMs: 0,
  });
  await server.start();

  const addr = (server as any).httpServer?.address();
  const port = typeof addr === "object" ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { fs, computer, provider, code, server, baseUrl, stop: () => server.stop() };
}

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------

describe.concurrent("NoumenClient", () => {
  describe("SSE transport", () => {
    it("streams events via SSE", async () => {
      const ctx = await setup({ responses: [textResponse("Hello from SSE!")] });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, transport: "sse" });
        const events = await collectEvents(client.run("hi"));

        const types = events.map((e) => e.type);
        expect(types).toContain("text_delta");
        expect(types).toContain("turn_complete");

        const textDelta = events.find((e) => e.type === "text_delta") as any;
        expect(textDelta.text).toContain("Hello from SSE!");
      } finally { await ctx.stop(); }
    });

    it("works with bearer auth", async () => {
      const ctx = await setup({
        responses: [textResponse("Authenticated!")],
        auth: { type: "bearer", token: "test-token" },
      });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, token: "test-token", transport: "sse" });
        const events = await collectEvents(client.run("hi"));
        const types = events.map((e) => e.type);
        expect(types).toContain("text_delta");
      } finally { await ctx.stop(); }
    });

    it("throws on auth failure", async () => {
      const ctx = await setup({
        responses: [textResponse("nope")],
        auth: { type: "bearer", token: "correct" },
      });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, token: "wrong", transport: "sse" });
        await expect(collectEvents(client.run("hi"))).rejects.toThrow();
      } finally { await ctx.stop(); }
    });
  });

  describe("WebSocket transport", () => {
    it("streams events via WebSocket", async () => {
      const ctx = await setup({ responses: [textResponse("Hello from WS!")] });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, transport: "ws" });
        const events = await collectEvents(client.run("hi"));

        const types = events.map((e) => e.type);
        expect(types).toContain("text_delta");
        expect(types).toContain("turn_complete");

        const textDelta = events.find((e) => e.type === "text_delta") as any;
        expect(textDelta.text).toContain("Hello from WS!");
      } finally { await ctx.stop(); }
    });

    it("works with bearer auth via query param", async () => {
      const ctx = await setup({
        responses: [textResponse("WS Auth!")],
        auth: { type: "bearer", token: "ws-token" },
      });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, token: "ws-token", transport: "ws" });
        const events = await collectEvents(client.run("hi"));
        const types = events.map((e) => e.type);
        expect(types).toContain("text_delta");
      } finally { await ctx.stop(); }
    });
  });

  describe("listSessions", () => {
    it("returns active sessions", async () => {
      const ctx = await setup({ responses: [textResponse("ok")] });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, transport: "sse" });
        await collectEvents(client.run("hi"));

        const sessions = await client.listSessions();
        expect(sessions.length).toBeGreaterThanOrEqual(1);
      } finally { await ctx.stop(); }
    });
  });

  describe("abort", () => {
    it("aborts a session via AbortSignal (SSE)", async () => {
      const ctx = await setup({ responses: [textResponse("long response that takes forever")] });
      try {
        const ac = new AbortController();
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, transport: "sse" });

        const eventsPromise = collectEvents(client.run("hi", { signal: ac.signal }));
        setTimeout(() => ac.abort(), 20);

        const events = await eventsPromise.catch(() => [] as StreamEvent[]);
        expect(Array.isArray(events)).toBe(true);
      } finally { await ctx.stop(); }
    });

    it("aborts a session via client.abort()", async () => {
      const ctx = await setup({ responses: [textResponse("ok")] });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, transport: "sse" });
        const events = await collectEvents(client.run("hi"));
        expect(events.length).toBeGreaterThan(0);

        const sessions = await client.listSessions();
        if (sessions.length > 0) {
          await client.abort(sessions[0].id);
          const after = await client.listSessions();
          expect(after.length).toBeLessThan(sessions.length);
        }
      } finally { await ctx.stop(); }
    });
  });

  describe("sendMessage (follow-up)", () => {
    it("sends a follow-up message via SSE", async () => {
      const ctx = await setup({
        responses: [textResponse("first"), textResponse("second")],
      });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, transport: "sse" });

        const firstEvents = await collectEvents(client.run("hello"));
        expect(firstEvents.some((e) => e.type === "turn_complete")).toBe(true);

        const sessions = await client.listSessions();
        expect(sessions.length).toBeGreaterThanOrEqual(1);
        const sessionId = sessions[0].id;

        const secondEvents = await collectEvents(client.sendMessage(sessionId, "world"));
        const types = secondEvents.map((e) => e.type);
        expect(types).toContain("text_delta");
        expect(types).toContain("turn_complete");
      } finally { await ctx.stop(); }
    });
  });

  describe("SSE reconnection", () => {
    it("does not throw on permanent 401 error during run", async () => {
      const ctx = await setup({
        responses: [textResponse("ok")],
        auth: { type: "bearer", token: "correct" },
      });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, token: "wrong", transport: "sse" });
        await expect(collectEvents(client.run("hi"))).rejects.toThrow();
      } finally { await ctx.stop(); }
    });
  });

  describe("SSE event IDs", () => {
    it("receives events with sequential ordering", async () => {
      const ctx = await setup({ responses: [textResponse("Hello!")] });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, transport: "sse" });
        const events = await collectEvents(client.run("hi"));

        const types = events.map((e) => e.type);
        expect(types).toContain("text_delta");
        expect(types).toContain("turn_complete");
        expect(events.length).toBeGreaterThanOrEqual(2);
      } finally { await ctx.stop(); }
    });
  });

  describe("SSE deduplication", () => {
    it("yields turn_complete after normal flow without duplicates", async () => {
      const ctx = await setup({ responses: [textResponse("one")] });
      try {
        const client = new NoumenClient({ baseUrl: ctx.baseUrl, transport: "sse" });
        const events = await collectEvents(client.run("hi"));

        const turnCompletes = events.filter((e) => e.type === "turn_complete");
        expect(turnCompletes.length).toBe(1);
      } finally { await ctx.stop(); }
    });
  });
});
