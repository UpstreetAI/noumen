import type { StreamEvent } from "../session/types.js";
import type { PermissionResponse } from "../permissions/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_GIVE_UP_MS = 600_000; // 10 minutes
const LIVENESS_TIMEOUT_MS = 45_000;
const PERMANENT_HTTP_CODES = new Set([401, 403, 404]);

// WS_OPEN = WebSocket.OPEN across all environments
const WS_OPEN = 1;
const WS_CONNECTING = 0;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClientOptions {
  /** Base URL of the noumen server, e.g. "http://localhost:3001". */
  baseUrl: string;
  /** Bearer token for authentication. */
  token?: string;
  /** Transport preference. "auto" tries WebSocket first, falls back to SSE. */
  transport?: "ws" | "sse" | "auto";
  /** Extra headers to send with HTTP requests (SSE transport). */
  headers?: Record<string, string>;
}

export interface PermissionRequestEvent {
  toolName: string;
  input: Record<string, unknown>;
  message: string;
}

export interface ClientRunOptions {
  /** Provide a session ID to resume an existing session. */
  sessionId?: string;
  signal?: AbortSignal;
  /** Called when the agent requests permission to run a tool. Return approval/denial. */
  onPermissionRequest?: (req: PermissionRequestEvent) => Promise<PermissionResponse>;
  /** Called when the agent asks the user a question. Return the answer. */
  onUserInput?: (question: string) => Promise<string>;
}

interface SessionCreatedResponse {
  sessionId: string;
  eventsUrl: string;
}

// ---------------------------------------------------------------------------
// NoumenClient
// ---------------------------------------------------------------------------

export class NoumenClient {
  private baseUrl: string;
  private token?: string;
  private transport: "ws" | "sse" | "auto";
  private headers: Record<string, string>;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.transport = options.transport ?? "auto";
    this.headers = options.headers ?? {};
  }

  async *run(prompt: string, opts?: ClientRunOptions): AsyncGenerator<StreamEvent> {
    const transport = this.resolveTransport();
    if (transport === "ws") {
      yield* this.runWs(prompt, opts);
    } else {
      yield* this.runSse(prompt, opts);
    }
  }

  async *sendMessage(
    sessionId: string,
    prompt: string,
    opts?: Omit<ClientRunOptions, "sessionId">,
  ): AsyncGenerator<StreamEvent> {
    const transport = this.resolveTransport();
    if (transport === "ws") {
      yield* this.sendMessageWs(sessionId, prompt, opts);
    } else {
      yield* this.sendMessageSse(sessionId, prompt, opts);
    }
  }

  async abort(sessionId: string): Promise<void> {
    await this.httpFetch(`/sessions/${sessionId}`, { method: "DELETE" });
  }

  async listSessions(): Promise<Array<{ id: string; lastActivity: number; done: boolean }>> {
    const res = await this.httpFetch("/sessions", { method: "GET" });
    return res.json() as Promise<Array<{ id: string; lastActivity: number; done: boolean }>>;
  }

  // -------------------------------------------------------------------------
  // Transport resolution
  // -------------------------------------------------------------------------

  private resolveTransport(): "ws" | "sse" {
    if (this.transport === "ws") return "ws";
    if (this.transport === "sse") return "sse";
    if (typeof globalThis.WebSocket !== "undefined") return "ws";
    return "sse";
  }

  // -------------------------------------------------------------------------
  // WebSocket transport
  // -------------------------------------------------------------------------

  private async *runWs(prompt: string, opts?: ClientRunOptions): AsyncGenerator<StreamEvent> {
    const ws = new globalThis.WebSocket(this.buildWsUrl());

    yield* this.driveWs(ws, opts, () => {
      ws.send(JSON.stringify({
        type: "run",
        prompt,
        sessionId: opts?.sessionId,
      }));
    });
  }

  private async *sendMessageWs(
    sessionId: string,
    prompt: string,
    opts?: Omit<ClientRunOptions, "sessionId">,
  ): AsyncGenerator<StreamEvent> {
    const ws = new globalThis.WebSocket(this.buildWsUrl());

    yield* this.driveWs(ws, opts, () => {
      ws.send(JSON.stringify({
        type: "message",
        sessionId,
        prompt,
      }));
    });
  }

  private async *driveWs(
    ws: WebSocket,
    opts: ClientRunOptions | Omit<ClientRunOptions, "sessionId"> | undefined,
    onOpen: () => void,
  ): AsyncGenerator<StreamEvent> {
    type QueueItem = { event: StreamEvent } | { done: true } | { error: Error };
    const queue: QueueItem[] = [];
    let waiter: ((item: QueueItem) => void) | null = null;

    function enqueue(item: QueueItem) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(item);
      } else {
        queue.push(item);
      }
    }

    function dequeue(): Promise<QueueItem> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise<QueueItem>((resolve) => { waiter = resolve; });
    }

    ws.addEventListener("open", () => onOpen());

    ws.addEventListener("message", async (msg) => {
      try {
        const data = JSON.parse(typeof msg.data === "string" ? msg.data : String(msg.data));

        if (data.type === "session_created") return;

        if (data.type === "permission_request" && opts && "onPermissionRequest" in opts && opts.onPermissionRequest) {
          try {
            const response = await opts.onPermissionRequest({
              toolName: data.toolName,
              input: data.input,
              message: data.message,
            });
            ws.send(JSON.stringify({
              type: "permission_response",
              sessionId: data.sessionId,
              ...response,
            }));
          } catch {
            ws.send(JSON.stringify({
              type: "permission_response",
              sessionId: data.sessionId,
              allow: false,
              feedback: "Client error handling permission request",
            }));
          }
          enqueue({ event: data as StreamEvent });
          return;
        }

        if (data.type === "user_input_request" && opts?.onUserInput) {
          try {
            const answer = await opts.onUserInput(data.question);
            ws.send(JSON.stringify({
              type: "input_response",
              sessionId: data.sessionId,
              answer,
            }));
          } catch {
            ws.send(JSON.stringify({
              type: "input_response",
              sessionId: data.sessionId,
              answer: "",
            }));
          }
          enqueue({ event: data as StreamEvent });
          return;
        }

        if (data.type === "turn_complete") {
          enqueue({ event: data as StreamEvent });
          enqueue({ done: true });
          return;
        }

        enqueue({ event: data as StreamEvent });
      } catch (err) {
        enqueue({ error: err instanceof Error ? err : new Error(String(err)) });
      }
    });

    ws.addEventListener("close", () => enqueue({ done: true }));
    ws.addEventListener("error", (e) => {
      enqueue({ error: new Error("WebSocket error: " + String(e)) });
    });

    const handleAbort = () => {
      ws.close();
      enqueue({ done: true });
    };
    opts?.signal?.addEventListener("abort", handleAbort);

    try {
      while (true) {
        const item = await dequeue();
        if ("done" in item) return;
        if ("error" in item) throw item.error;
        yield item.event;
      }
    } finally {
      opts?.signal?.removeEventListener("abort", handleAbort);
      if (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING) {
        ws.close();
      }
    }
  }

  private buildWsUrl(): string {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const url = new URL("/ws", wsBase);
    if (this.token) url.searchParams.set("token", this.token);
    return url.toString();
  }

  // -------------------------------------------------------------------------
  // SSE transport
  // -------------------------------------------------------------------------

  private async *runSse(prompt: string, opts?: ClientRunOptions): AsyncGenerator<StreamEvent> {
    const createRes = await this.httpFetch("/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt, sessionId: opts?.sessionId }),
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create session: ${createRes.status} ${await createRes.text()}`);
    }

    const { sessionId, eventsUrl } = (await createRes.json()) as SessionCreatedResponse;
    yield* this.consumeSseStreamWithReconnect(sessionId, eventsUrl, opts);
  }

  private async *sendMessageSse(
    sessionId: string,
    prompt: string,
    opts?: Omit<ClientRunOptions, "sessionId">,
  ): AsyncGenerator<StreamEvent> {
    const msgRes = await this.httpFetch(`/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });

    if (!msgRes.ok) {
      throw new Error(`Failed to send message: ${msgRes.status} ${await msgRes.text()}`);
    }

    yield* this.consumeSseStreamWithReconnect(sessionId, `/sessions/${sessionId}/events`, opts);
  }

  /**
   * SSE stream consumer with automatic reconnection, liveness detection,
   * and event deduplication via sequence numbers.
   */
  private async *consumeSseStreamWithReconnect(
    sessionId: string,
    eventsPath: string,
    opts?: ClientRunOptions | Omit<ClientRunOptions, "sessionId">,
  ): AsyncGenerator<StreamEvent> {
    const state = { lastSeqNum: 0 };
    let reconnectAttempts = 0;
    let reconnectStartTime: number | null = null;
    let turnComplete = false;

    while (!turnComplete) {
      if (opts?.signal?.aborted) return;

      try {
        for await (const event of this.consumeSseStream(sessionId, eventsPath, opts, state)) {
          yield event;

          if (event.type === "turn_complete") {
            turnComplete = true;
            return;
          }
        }

        if (turnComplete) return;
      } catch (err) {
        if (opts?.signal?.aborted) return;
        if ((err as Error).name === "AbortError") return;

        // Permanent HTTP errors — don't reconnect
        const msg = (err as Error).message ?? "";
        const statusMatch = msg.match(/SSE connection failed: (\d+)/);
        if (statusMatch && PERMANENT_HTTP_CODES.has(parseInt(statusMatch[1], 10))) {
          throw err;
        }
      }

      // Reconnection logic
      if (opts?.signal?.aborted) return;
      const now = Date.now();
      if (!reconnectStartTime) reconnectStartTime = now;

      const elapsed = now - reconnectStartTime;
      if (elapsed >= RECONNECT_GIVE_UP_MS) {
        throw new Error(`SSE reconnection failed after ${Math.round(elapsed / 1000)}s`);
      }

      reconnectAttempts++;
      const baseDelay = Math.min(
        RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
        RECONNECT_MAX_DELAY_MS,
      );
      const delay = Math.max(0, baseDelay + baseDelay * 0.25 * (2 * Math.random() - 1));
      await sleep(delay, opts?.signal);
      if (opts?.signal?.aborted) return;
    }
  }

  /**
   * Single SSE connection attempt. Yields events and returns when the stream
   * ends (either gracefully via turn_complete or from a dropped connection).
   * The liveness timer triggers an AbortError if no frames arrive within
   * LIVENESS_TIMEOUT_MS.
   */
  private async *consumeSseStream(
    sessionId: string,
    eventsPath: string,
    opts: ClientRunOptions | Omit<ClientRunOptions, "sessionId"> | undefined,
    state: { lastSeqNum: number },
  ): AsyncGenerator<StreamEvent> {
    const url = `${this.baseUrl}${eventsPath}`;
    const headers: Record<string, string> = { ...this.headers };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (state.lastSeqNum > 0) headers["Last-Event-ID"] = String(state.lastSeqNum);

    const ac = new AbortController();
    if (opts?.signal) {
      if (opts.signal.aborted) { ac.abort(); return; }
      opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }

    // Liveness timeout — abort if no data for 45s
    let livenessTimer: ReturnType<typeof setTimeout> | null = null;
    const resetLiveness = () => {
      if (livenessTimer) clearTimeout(livenessTimer);
      livenessTimer = setTimeout(() => ac.abort(), LIVENESS_TIMEOUT_MS);
    };
    const clearLiveness = () => {
      if (livenessTimer) { clearTimeout(livenessTimer); livenessTimer = null; }
    };

    const response = await globalThis.fetch(url, { headers, signal: ac.signal });

    if (!response.ok) {
      clearLiveness();
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) { clearLiveness(); throw new Error("No response body"); }

    const decoder = new TextDecoder();
    let buffer = "";
    resetLiveness();

    let currentEventId = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetLiveness();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          // SSE comments (like :keepalive) reset liveness but carry no data
          if (line.startsWith(":")) {
            resetLiveness();
            continue;
          }

          // Track SSE id: field for sequence-based dedup
          if (line.startsWith("id: ")) {
            const seqNum = parseInt(line.slice(4), 10);
            if (!isNaN(seqNum)) currentEventId = seqNum;
            continue;
          }

          if (!line.startsWith("data: ")) continue;

          const json = line.slice(6);
          if (!json) continue;

          // Dedup: skip events already seen before reconnect
          if (currentEventId > 0 && currentEventId <= state.lastSeqNum) {
            currentEventId = 0;
            continue;
          }
          if (currentEventId > state.lastSeqNum) {
            state.lastSeqNum = currentEventId;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(json);
          } catch {
            continue;
          }

          currentEventId = 0;
          const eventType = parsed.type as string;

          if (eventType === "permission_request" && opts && "onPermissionRequest" in opts && opts.onPermissionRequest) {
            try {
              const permResponse = await opts.onPermissionRequest({
                toolName: parsed.toolName as string,
                input: parsed.input as Record<string, unknown>,
                message: parsed.message as string,
              });
              await this.httpFetch(`/sessions/${sessionId}/permissions`, {
                method: "POST",
                body: JSON.stringify(permResponse),
              });
            } catch {
              await this.httpFetch(`/sessions/${sessionId}/permissions`, {
                method: "POST",
                body: JSON.stringify({ allow: false }),
              });
            }
          }

          if (eventType === "user_input_request" && opts?.onUserInput) {
            try {
              const answer = await opts.onUserInput(parsed.question as string);
              await this.httpFetch(`/sessions/${sessionId}/input`, {
                method: "POST",
                body: JSON.stringify({ answer }),
              });
            } catch {
              await this.httpFetch(`/sessions/${sessionId}/input`, {
                method: "POST",
                body: JSON.stringify({ answer: "" }),
              });
            }
          }

          yield parsed as unknown as StreamEvent;

          if (eventType === "turn_complete") {
            ac.abort();
            return;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    } finally {
      clearLiveness();
      try { reader.releaseLock(); } catch { /* already released */ }
      if (!ac.signal.aborted) ac.abort();
    }
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  private httpFetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headers,
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

    return globalThis.fetch(url, { ...init, headers: { ...headers, ...init?.headers as Record<string, string> } });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
