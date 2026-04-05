import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "../session/types.js";
import type { ChatStreamChunk } from "../providers/types.js";
import { Thread, type ThreadConfig } from "../thread.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import { getRetryDelay } from "../retry/backoff.js";
import { classifyError, isRetryable } from "../retry/classify.js";
import { withRetry, CannotRetryError } from "../retry/engine.js";
import { DEFAULT_RETRY_CONFIG } from "../retry/types.js";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textChunk,
  stopChunk,
} from "./helpers.js";

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("Backoff", () => {
  it("uses Retry-After header when available", () => {
    const delay = getRetryDelay(1, "5");
    expect(delay).toBe(5000);
  });

  it("uses exponential backoff without Retry-After", () => {
    const d1 = getRetryDelay(1, null);
    const d2 = getRetryDelay(2, null);
    const d3 = getRetryDelay(3, null);
    // Base: 500ms * 2^(attempt-1)
    expect(d1).toBeGreaterThanOrEqual(500);
    expect(d1).toBeLessThanOrEqual(625); // 500 + 25% jitter
    expect(d2).toBeGreaterThanOrEqual(1000);
    expect(d3).toBeGreaterThanOrEqual(2000);
  });

  it("caps at maxDelayMs", () => {
    const delay = getRetryDelay(20, null, 5000);
    expect(delay).toBeLessThanOrEqual(5000 * 1.25);
  });
});

describe("Error classification", () => {
  it("classifies 429 status as retryable", () => {
    const error = { status: 429, message: "Rate limited" };
    const classified = classifyError(error);
    expect(classified.status).toBe(429);
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(true);
  });

  it("classifies 529 as overloaded", () => {
    const error = { status: 529, message: "Overloaded" };
    const classified = classifyError(error);
    expect(classified.isOverloaded).toBe(true);
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(true);
  });

  it("classifies overloaded_error message as overloaded", () => {
    const error = new Error('{"type":"overloaded_error"}');
    const classified = classifyError(error);
    expect(classified.isOverloaded).toBe(true);
  });

  it("classifies 400 with context overflow message", () => {
    const error = {
      status: 400,
      message:
        "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000",
    };
    const classified = classifyError(error);
    expect(classified.isContextOverflow).toBe(true);
    expect(classified.contextOverflowData).toEqual({
      inputTokens: 188059,
      maxTokens: 20000,
      contextLimit: 200000,
    });
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(true);
  });

  it("classifies connection errors as retryable", () => {
    const error = { name: "APIConnectionError", message: "Connection failed" };
    const classified = classifyError(error);
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(true);
  });

  it("extracts Retry-After from headers", () => {
    const error = {
      status: 429,
      message: "Rate limited",
      headers: { "retry-after": "30" },
    };
    const classified = classifyError(error);
    expect(classified.retryAfter).toBe("30");
  });

  it("extracts Retry-After from Headers.get()", () => {
    const headers = new Map([["retry-after", "60"]]);
    const error = {
      status: 429,
      message: "Rate limited",
      headers: { get: (k: string) => headers.get(k) ?? null },
    };
    const classified = classifyError(error);
    expect(classified.retryAfter).toBe("60");
  });

  it("classifies non-retryable status as not retryable", () => {
    const error = { status: 403, message: "Forbidden" };
    const classified = classifyError(error);
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(false);
  });
});

describe("withRetry engine", () => {
  it("returns stream on first success", async () => {
    async function* mockStream(): AsyncIterable<ChatStreamChunk> {
      yield textChunk("hello");
      yield stopChunk();
    }

    const gen = withRetry(
      () => mockStream(),
      { ...DEFAULT_RETRY_CONFIG, model: "test" },
    );

    const events: StreamEvent[] = [];
    let result = await gen.next();
    while (!result.done) {
      events.push(result.value);
      result = await gen.next();
    }

    expect(events).toHaveLength(0); // No retry events
    // Consume the returned stream
    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of result.value) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
  });

  it("retries on retryable error and eventually succeeds", async () => {
    let callCount = 0;

    async function* mockStream(): AsyncIterable<ChatStreamChunk> {
      callCount++;
      if (callCount <= 2) {
        throw Object.assign(new Error("Rate limited"), { status: 429 });
      }
      yield textChunk("success");
      yield stopChunk();
    }

    const gen = withRetry(
      () => mockStream(),
      { ...DEFAULT_RETRY_CONFIG, maxRetries: 5, model: "test", baseDelayMs: 1 },
    );

    const events: StreamEvent[] = [];
    let result = await gen.next();
    while (!result.done) {
      events.push(result.value);
      result = await gen.next();
    }

    expect(callCount).toBe(3);
    expect(events.filter((e) => e.type === "retry_attempt")).toHaveLength(2);
  });

  it("throws CannotRetryError on non-retryable error", async () => {
    async function* mockStream(): AsyncIterable<ChatStreamChunk> {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }

    const gen = withRetry(
      () => mockStream(),
      { ...DEFAULT_RETRY_CONFIG, model: "test" },
    );

    await expect(async () => {
      let result = await gen.next();
      while (!result.done) {
        result = await gen.next();
      }
    }).rejects.toThrow(CannotRetryError);
  });

  it("adjusts maxTokensOverride on context overflow", async () => {
    let receivedCtx: { maxTokensOverride?: number } | undefined;
    let callCount = 0;

    async function* mockStream(ctx: { maxTokensOverride?: number }): AsyncIterable<ChatStreamChunk> {
      callCount++;
      if (callCount === 1) {
        throw Object.assign(
          new Error(
            "input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000",
          ),
          { status: 400 },
        );
      }
      receivedCtx = ctx;
      yield textChunk("ok");
      yield stopChunk();
    }

    const gen = withRetry(
      (ctx) => mockStream(ctx),
      { ...DEFAULT_RETRY_CONFIG, model: "test", baseDelayMs: 1 },
    );

    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }

    expect(callCount).toBe(2);
    expect(receivedCtx?.maxTokensOverride).toBeDefined();
    // available = 200000 - 190000 - 1000 = 9000
    expect(receivedCtx!.maxTokensOverride).toBe(9000);
  });

  it("switches to fallback model after consecutive overloaded errors", async () => {
    let callCount = 0;
    const models: string[] = [];

    async function* mockStream(ctx: { model: string }): AsyncIterable<ChatStreamChunk> {
      callCount++;
      models.push(ctx.model);
      if (callCount <= 3) {
        throw Object.assign(new Error("Overloaded"), { status: 529 });
      }
      yield textChunk("fallback worked");
      yield stopChunk();
    }

    const gen = withRetry(
      (ctx) => mockStream(ctx),
      {
        ...DEFAULT_RETRY_CONFIG,
        model: "primary-model",
        fallbackModel: "fallback-model",
        maxConsecutiveOverloaded: 3,
        baseDelayMs: 1,
      },
    );

    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }

    expect(callCount).toBe(4);
    expect(models[3]).toBe("fallback-model");
  });

  it("yields retry_exhausted when all retries fail", async () => {
    async function* mockStream(): AsyncIterable<ChatStreamChunk> {
      throw Object.assign(new Error("Server error"), { status: 500 });
    }

    const gen = withRetry(
      () => mockStream(),
      { ...DEFAULT_RETRY_CONFIG, maxRetries: 2, model: "test", baseDelayMs: 1 },
    );

    const events: StreamEvent[] = [];
    try {
      let result = await gen.next();
      while (!result.done) {
        events.push(result.value);
        result = await gen.next();
      }
    } catch {
      // expected
    }

    const exhausted = events.filter((e) => e.type === "retry_exhausted");
    expect(exhausted).toHaveLength(1);
  });

  it("respects abort signal", async () => {
    const ac = new AbortController();
    ac.abort();

    async function* mockStream(): AsyncIterable<ChatStreamChunk> {
      yield textChunk("should not reach");
    }

    const gen = withRetry(
      () => mockStream(),
      { ...DEFAULT_RETRY_CONFIG, model: "test", signal: ac.signal },
    );

    await expect(async () => {
      let result = await gen.next();
      while (!result.done) {
        result = await gen.next();
      }
    }).rejects.toThrow();
  });
});

describe("Nested connection errors", () => {
  it("detects connection error in nested cause chain", () => {
    const deepError = {
      message: "wrapper",
      cause: {
        message: "mid",
        cause: {
          code: "ECONNRESET",
          message: "connection reset",
        },
      },
    };
    const classified = classifyError(deepError);
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(true);
  });

  it("detects APIConnectionError at depth > 1", () => {
    const wrappedError = {
      message: "outer",
      cause: {
        name: "APIConnectionError",
        message: "conn failed",
      },
    };
    const classified = classifyError(wrappedError);
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(true);
  });
});

describe("Overloaded always retryable", () => {
  it("529 is retryable regardless of retryableStatuses config", () => {
    const error = { status: 529, message: "Overloaded" };
    const classified = classifyError(error);
    expect(classified.isOverloaded).toBe(true);
    // Even with a restrictive retryableStatuses list, overloaded should be retryable
    expect(isRetryable(classified, { ...DEFAULT_RETRY_CONFIG, retryableStatuses: [429] })).toBe(true);
  });
});

describe("baseDelayMs parameter", () => {
  it("produces different delays with custom baseDelayMs", () => {
    const defaultDelay = getRetryDelay(1, null, 32000, 500);
    const customDelay = getRetryDelay(1, null, 32000, 100);
    // Custom base should be ~5x smaller
    expect(customDelay).toBeLessThan(defaultDelay);
    expect(customDelay).toBeLessThanOrEqual(125); // 100 + 25% jitter
  });
});

describe("Attempt counter reset on fallback", () => {
  it("gives fallback model retries within the global budget", async () => {
    let callCount = 0;
    const models: string[] = [];

    async function* mockStream(ctx: { model: string }): AsyncIterable<ChatStreamChunk> {
      callCount++;
      models.push(ctx.model);
      if (models.length <= 3) {
        throw Object.assign(new Error("Overloaded"), { status: 529 });
      }
      if (models.length === 4) {
        throw Object.assign(new Error("Rate limited"), { status: 429 });
      }
      yield textChunk("success");
      yield stopChunk();
    }

    const gen = withRetry(
      (ctx) => mockStream(ctx),
      {
        ...DEFAULT_RETRY_CONFIG,
        model: "primary",
        fallbackModel: "fallback",
        maxConsecutiveOverloaded: 3,
        maxRetries: 5,
        baseDelayMs: 1,
      },
    );

    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }

    // 3 primary overloaded + 1 fallback 429 + 1 fallback success = 5 total
    expect(callCount).toBe(5);
    expect(callCount).toBeLessThanOrEqual(6);
    expect(models[3]).toBe("fallback");
    expect(models[4]).toBe("fallback");
  });
});

describe("Retry in Thread", () => {
  let fs: MockFs;
  let computer: MockComputer;
  let baseConfig: ThreadConfig;

  beforeEach(() => {
    fs = new MockFs();
    computer = new MockComputer();
    baseConfig = {
      provider: {} as any, // replaced per-test
      fs,
      computer,
      sessionDir: "/sessions",
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };
  });

  it("yields retry_attempt events when retries occur", async () => {
    let callCount = 0;
    const failingProvider = {
      async *chat() {
        callCount++;
        if (callCount === 1) {
          throw Object.assign(new Error("Rate limited"), { status: 429 });
        }
        yield textChunk("success");
        yield stopChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      },
    };

    const thread = new Thread(
      {
        ...baseConfig,
        provider: failingProvider,
        retry: { maxRetries: 3, baseDelayMs: 1 },
      },
      { sessionId: "retry-1" },
    );

    const events = await collectEvents(thread.run("hello"));
    const retryEvents = events.filter((e) => e.type === "retry_attempt");
    expect(retryEvents).toHaveLength(1);
    expect(callCount).toBe(2);

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
  });
});

describe("OpenAI context overflow classification", () => {
  it("parses OpenAI overflow with correct inputTokens (totalTokens, not contextLimit)", () => {
    const error = {
      status: 400,
      message:
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    };
    const classified = classifyError(error);
    expect(classified.isContextOverflow).toBe(true);
    expect(classified.contextOverflowData).toBeDefined();
    expect(classified.contextOverflowData!.inputTokens).toBe(130000);
    expect(classified.contextOverflowData!.contextLimit).toBe(128000);
    expect(classified.contextOverflowData!.maxTokens).toBe(2000);
  });

  it("throws CannotRetryError for large OpenAI overflow (available < FLOOR)", async () => {
    let callCount = 0;

    async function* mockStream(): AsyncIterable<ChatStreamChunk> {
      callCount++;
      throw Object.assign(
        new Error(
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
        ),
        { status: 400 },
      );
    }

    // With the fix: inputTokens=130000, available = 128000 - 130000 - 1000 = -3000 → 0 < 3000 → CannotRetryError
    const gen = withRetry(
      () => mockStream(),
      { ...DEFAULT_RETRY_CONFIG, model: "test", baseDelayMs: 1 },
    );

    await expect(async () => {
      let result = await gen.next();
      while (!result.done) {
        result = await gen.next();
      }
    }).rejects.toThrow(CannotRetryError);

    expect(callCount).toBe(1);
  });
});

describe("withRetry — empty stream triggers retry", () => {
  it("retries when provider returns empty stream", async () => {
    let callCount = 0;

    async function* mockStream(): AsyncIterable<ChatStreamChunk> {
      callCount++;
      if (callCount === 1) {
        return; // empty stream
      }
      yield textChunk("recovered");
      yield stopChunk();
    }

    const gen = withRetry(
      () => mockStream(),
      { ...DEFAULT_RETRY_CONFIG, maxRetries: 3, model: "test", baseDelayMs: 1 },
    );

    const events: StreamEvent[] = [];
    let result = await gen.next();
    while (!result.done) {
      events.push(result.value);
      result = await gen.next();
    }

    expect(callCount).toBe(2);
    const retryEvents = events.filter((e) => e.type === "retry_attempt");
    expect(retryEvents).toHaveLength(1);
  });
});

describe("Backoff — Retry-After capped by maxDelayMs", () => {
  it("caps Retry-After at maxDelayMs instead of 6 hours", () => {
    const delay = getRetryDelay(1, "3600", 32000);
    expect(delay).toBe(32000);
  });

  it("allows Retry-After below maxDelayMs", () => {
    const delay = getRetryDelay(1, "5", 32000);
    expect(delay).toBe(5000);
  });
});

describe("Error classification — 401 not retryable by default", () => {
  it("classifies 401 as not retryable (credentials not refreshed)", () => {
    const error = { status: 401, message: "Unauthorized" };
    const classified = classifyError(error);
    expect(classified.status).toBe(401);
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(false);
  });

  it("classifies 401 as retryable when explicitly configured", () => {
    const error = { status: 401, message: "Unauthorized" };
    const classified = classifyError(error);
    expect(isRetryable(classified, { retryableStatuses: [401] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retry engine default status codes
// ---------------------------------------------------------------------------
describe("retry engine fixes", () => {
  it("401 is not in default retryable statuses", () => {
    expect(DEFAULT_RETRY_CONFIG.retryableStatuses).not.toContain(401);
  });

  it("401 errors are not retryable with defaults", () => {
    const classified = classifyError({ status: 401, message: "Unauthorized" });
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(false);
  });

  it("429 errors are still retryable", () => {
    const classified = classifyError({ status: 429, message: "Rate limited" });
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// retry engine totalAttempts budget
// ---------------------------------------------------------------------------
describe("retry engine totalAttempts budget", () => {
  it("does not exceed maxRetries total attempts even after fallback", async () => {
    let callCount = 0;

    async function* mockStream(): AsyncIterable<ChatStreamChunk> {
      callCount++;
      throw Object.assign(new Error("Overloaded"), { status: 529 });
    }

    const gen = withRetry(
      () => mockStream(),
      {
        ...DEFAULT_RETRY_CONFIG,
        model: "primary",
        fallbackModel: "fallback",
        maxConsecutiveOverloaded: 2,
        maxRetries: 6,
        baseDelayMs: 1,
      },
    );

    const events: StreamEvent[] = [];
    try {
      let result = await gen.next();
      while (!result.done) {
        events.push(result.value);
        result = await gen.next();
      }
    } catch {
      // expected exhaustion
    }

    expect(callCount).toBeLessThanOrEqual(7);
  });
});
