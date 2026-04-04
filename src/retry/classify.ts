import type { RetryConfig } from "./types.js";

/**
 * Provider-agnostic error classification for retry decisions.
 * Extracts status codes and retry hints from common SDK error shapes
 * without depending on any specific provider's types.
 */
export interface ClassifiedError {
  originalError: unknown;
  message: string;
  status?: number;
  retryAfter?: string;
  isOverloaded: boolean;
  isContextOverflow: boolean;
  contextOverflowData?: {
    inputTokens: number;
    maxTokens: number;
    contextLimit: number;
  };
}

/**
 * Classify an unknown error into retry-relevant metadata.
 * Works across OpenAI, Anthropic, and Gemini SDK error shapes by
 * duck-typing common properties (`.status`, `.headers`, `.message`).
 */
export function classifyError(error: unknown): ClassifiedError {
  let msg: string;
  if (error instanceof Error) {
    msg = error.message;
  } else if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    msg = (error as { message: string }).message;
  } else {
    msg = String(error);
  }

  const status = extractStatus(error);
  const retryAfter = extractRetryAfter(error);

  const isOverloaded =
    status === 529 ||
    msg.includes('"type":"overloaded_error"') ||
    msg.toLowerCase().includes("overloaded");

  const contextOverflowData = parseContextOverflow(msg, status);

  return {
    originalError: error,
    message: msg,
    status,
    retryAfter,
    isOverloaded,
    isContextOverflow: contextOverflowData !== undefined,
    contextOverflowData,
  };
}

export function isRetryable(
  classified: ClassifiedError,
  config: RetryConfig,
): boolean {
  if (classified.isContextOverflow) return true;

  if (classified.status !== undefined) {
    const retryableStatuses = config.retryableStatuses ?? [408, 409, 429, 500, 502, 503, 529];
    if (retryableStatuses.includes(classified.status)) return true;
  }

  if (isConnectionError(classified.originalError)) return true;

  return false;
}

function extractStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return undefined;
}

function extractRetryAfter(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;

    // Direct property (ChatStreamError)
    if (typeof e.retryAfter === "string") return e.retryAfter;

    // Headers object (Anthropic/OpenAI SDK errors)
    if (e.headers && typeof e.headers === "object") {
      const headers = e.headers as Record<string, unknown>;
      if (typeof headers["retry-after"] === "string") return headers["retry-after"];
      if (typeof (headers as { get?: (k: string) => string | null }).get === "function") {
        const val = (headers as { get: (k: string) => string | null }).get("retry-after");
        if (val) return val;
      }
    }
  }
  return undefined;
}

/**
 * Parse context overflow errors from any provider.
 * Anthropic: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
 * OpenAI: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens."
 */
function parseContextOverflow(
  message: string,
  status?: number,
): ClassifiedError["contextOverflowData"] | undefined {
  if (status !== 400 && status !== 413) return undefined;

  // Anthropic format
  const anthropicRegex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/;
  const anthropicMatch = message.match(anthropicRegex);
  if (anthropicMatch && anthropicMatch[1] && anthropicMatch[2] && anthropicMatch[3]) {
    return {
      inputTokens: parseInt(anthropicMatch[1], 10),
      maxTokens: parseInt(anthropicMatch[2], 10),
      contextLimit: parseInt(anthropicMatch[3], 10),
    };
  }

  // OpenAI format
  const openaiRegex =
    /maximum context length is (\d+) tokens.*?resulted in (\d+) tokens/;
  const openaiMatch = message.match(openaiRegex);
  if (openaiMatch && openaiMatch[1] && openaiMatch[2]) {
    const contextLimit = parseInt(openaiMatch[1], 10);
    const totalTokens = parseInt(openaiMatch[2], 10);
    return {
      inputTokens: totalTokens,
      maxTokens: totalTokens - contextLimit,
      contextLimit,
    };
  }

  return undefined;
}

function isConnectionError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "";
    if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return true;
    const code = typeof e.code === "string" ? e.code : "";
    if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNREFUSED" || code === "ETIMEDOUT") return true;
  }
  return false;
}
