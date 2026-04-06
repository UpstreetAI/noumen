/**
 * Provider conformance tests.
 *
 * Tests the contract between the error classification system and various
 * provider error shapes, plus ChatStreamError metadata propagation.
 */
import { describe, it, expect } from "vitest";
import { ChatStreamError } from "../providers/types.js";
import { classifyError, isRetryable } from "../retry/classify.js";
import type { RetryConfig } from "../retry/types.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";
import { assertValidMessageSequence } from "../messages/invariants.js";
import type { ChatMessage, AssistantMessage } from "../session/types.js";

const defaultRetryConfig: RetryConfig = {
  maxRetries: 3,
  retryableStatuses: [408, 409, 429, 500, 502, 503, 504, 529],
};

// ---------------------------------------------------------------------------
// ChatStreamError classification
// ---------------------------------------------------------------------------

describe("ChatStreamError classification", () => {
  it("classifies 429 as retryable with retryAfter", () => {
    const err = new ChatStreamError("Rate limited", {
      status: 429,
      retryAfter: "2",
    });
    const classified = classifyError(err);
    expect(classified.status).toBe(429);
    expect(classified.retryAfter).toBe("2");
    expect(classified.isOverloaded).toBe(false);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(true);
  });

  it("classifies 400 as not retryable by default", () => {
    const err = new ChatStreamError("Bad request", { status: 400 });
    const classified = classifyError(err);
    expect(classified.status).toBe(400);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(false);
  });

  it("classifies 529 as overloaded and retryable", () => {
    const err = new ChatStreamError("Overloaded", { status: 529 });
    const classified = classifyError(err);
    expect(classified.status).toBe(529);
    expect(classified.isOverloaded).toBe(true);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(true);
  });

  it("classifies 502 as retryable", () => {
    const err = new ChatStreamError("Bad Gateway", { status: 502 });
    const classified = classifyError(err);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(true);
  });

  it("classifies 503 as retryable", () => {
    const err = new ChatStreamError("Service Unavailable", { status: 503 });
    const classified = classifyError(err);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(true);
  });

  it("classifies 408 timeout as retryable", () => {
    const err = new ChatStreamError("Timeout", { status: 408 });
    const classified = classifyError(err);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(true);
  });

  it("classifies 200-range as not retryable", () => {
    const err = new ChatStreamError("Weird error", { status: 200 });
    const classified = classifyError(err);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Overloaded error detection (various shapes)
// ---------------------------------------------------------------------------

describe("overloaded error detection", () => {
  it("detects status 529 as overloaded", () => {
    const err = { message: "Server busy", status: 529 };
    const classified = classifyError(err);
    expect(classified.isOverloaded).toBe(true);
  });

  it("detects overloaded_error in message body", () => {
    const err = new Error('{"type":"overloaded_error","message":"overloaded"}');
    const classified = classifyError(err);
    expect(classified.isOverloaded).toBe(true);
  });

  it("non-overloaded 500 is not flagged as overloaded", () => {
    const err = { message: "Internal error", status: 500 };
    const classified = classifyError(err);
    expect(classified.isOverloaded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Context overflow detection
// ---------------------------------------------------------------------------

describe("context overflow detection", () => {
  it("parses Anthropic context overflow format", () => {
    const err = new ChatStreamError(
      "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000",
      { status: 400 },
    );
    const classified = classifyError(err);
    expect(classified.isContextOverflow).toBe(true);
    expect(classified.contextOverflowData).toEqual({
      inputTokens: 188059,
      maxTokens: 20000,
      contextLimit: 200000,
    });
    expect(isRetryable(classified, defaultRetryConfig)).toBe(true);
  });

  it("parses OpenAI context overflow format", () => {
    const err = new ChatStreamError(
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      { status: 400 },
    );
    const classified = classifyError(err);
    expect(classified.isContextOverflow).toBe(true);
    expect(classified.contextOverflowData?.contextLimit).toBe(128000);
    expect(classified.contextOverflowData?.inputTokens).toBe(130000);
  });

  it("parses Gemini context overflow format", () => {
    const err = new ChatStreamError(
      "prompt is too long: 150000 tokens > 128000",
      { status: 400 },
    );
    const classified = classifyError(err);
    expect(classified.isContextOverflow).toBe(true);
    expect(classified.contextOverflowData?.contextLimit).toBe(128000);
  });

  it("does not detect overflow for non-400 status", () => {
    const err = new ChatStreamError(
      "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000",
      { status: 500 },
    );
    const classified = classifyError(err);
    expect(classified.isContextOverflow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SDK error duck-typing (Anthropic, OpenAI headers)
// ---------------------------------------------------------------------------

describe("SDK error duck-typing", () => {
  it("extracts retryAfter from headers object with get method", () => {
    const err = {
      message: "Rate limited",
      status: 429,
      headers: {
        get(name: string) {
          if (name === "retry-after") return "5";
          return null;
        },
      },
    };
    const classified = classifyError(err);
    expect(classified.retryAfter).toBe("5");
  });

  it("extracts retryAfter from plain headers record", () => {
    const err = {
      message: "Rate limited",
      status: 429,
      headers: { "retry-after": "10" },
    };
    const classified = classifyError(err);
    expect(classified.retryAfter).toBe("10");
  });

  it("handles statusCode property (alternative to status)", () => {
    const err = { message: "Timeout", statusCode: 408 };
    const classified = classifyError(err);
    expect(classified.status).toBe(408);
  });

  it("handles non-Error objects", () => {
    const classified = classifyError("raw string error");
    expect(classified.message).toBe("raw string error");
    expect(classified.status).toBeUndefined();
  });

  it("handles null/undefined", () => {
    const classified = classifyError(null);
    expect(classified.message).toBe("null");
    expect(classified.isOverloaded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection errors
// ---------------------------------------------------------------------------

describe("connection error classification", () => {
  it("classifies ECONNRESET as retryable", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const classified = classifyError(err);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(true);
  });

  it("classifies ETIMEDOUT as retryable", () => {
    const err = Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" });
    const classified = classifyError(err);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(true);
  });

  it("classifies APIConnectionError by name as retryable", () => {
    const err = Object.assign(new Error("connection failed"), { name: "APIConnectionError" });
    const classified = classifyError(err);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(true);
  });

  it("classifies nested cause with connection code as retryable", () => {
    const cause = Object.assign(new Error("inner"), { code: "ECONNREFUSED" });
    const err = Object.assign(new Error("outer"), { cause });
    const classified = classifyError(err);
    expect(isRetryable(classified, defaultRetryConfig)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provider message conformance — normalized messages are valid for any provider
// ---------------------------------------------------------------------------

describe("provider message conformance", () => {
  it("normalized empty conversation is valid", () => {
    const result = normalizeMessagesForAPI([]);
    assertValidMessageSequence(result);
    expect(result[0].role).toBe("user");
  });

  it("normalized multi-tool conversation is valid", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "read two files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"/a.txt"}' } },
          { id: "t2", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"/b.txt"}' } },
        ],
      } as AssistantMessage,
      { role: "tool", tool_call_id: "t1", content: "aaa" },
      { role: "tool", tool_call_id: "t2", content: "bbb" },
      { role: "assistant", content: "Both files read." } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);

    const idempotent = normalizeMessagesForAPI(result);
    expect(idempotent).toEqual(result);
  });

  it("normalized conversation with thinking fields strips stale sigs", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "think hard" },
      {
        role: "assistant",
        content: "first",
        thinking_content: "deep",
        thinking_signature: "sig1",
      } as AssistantMessage,
      { role: "user", content: "think more" },
      {
        role: "assistant",
        content: "second",
        thinking_content: "deeper",
        thinking_signature: "sig2",
      } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);

    const assistants = result.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants[0].thinking_signature).toBeUndefined();
    expect(assistants[1].thinking_signature).toBe("sig2");
  });

  it("custom retryableStatuses config is respected", () => {
    const customConfig: RetryConfig = {
      maxRetries: 3,
      retryableStatuses: [418], // I'm a teapot
    };

    const err = new ChatStreamError("teapot", { status: 418 });
    const classified = classifyError(err);
    expect(isRetryable(classified, customConfig)).toBe(true);

    const err500 = new ChatStreamError("server error", { status: 500 });
    const classified500 = classifyError(err500);
    expect(isRetryable(classified500, customConfig)).toBe(false);
  });
});
