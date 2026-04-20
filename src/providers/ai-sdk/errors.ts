/**
 * Maps AI SDK `APICallError` (and similar provider errors) onto noumen's
 * `ChatStreamError`, preserving the HTTP status code and `Retry-After`
 * header so the existing retry engine (`pipeline/provider-round.ts`) can
 * make backoff decisions without knowing about `@ai-sdk/provider`.
 */

import { ChatStreamError } from "../types.js";

// We duck-type the error instead of `instanceof APICallError` so noumen
// doesn't pay the cost of importing `@ai-sdk/provider` at runtime when it
// isn't needed. The shape is part of the public AI SDK contract.
interface ApiCallErrorLike {
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  isRetryable?: boolean;
  message: string;
}

function isApiCallErrorLike(err: unknown): err is ApiCallErrorLike {
  if (!err || typeof err !== "object") return false;
  // APICallError extends AISDKError which exposes a brand via `name`.
  const name = (err as { name?: unknown }).name;
  if (name !== "AI_APICallError" && name !== "APICallError") return false;
  return typeof (err as { message?: unknown }).message === "string";
}

export function mapApiCallError(err: unknown): ChatStreamError {
  if (err instanceof ChatStreamError) return err;

  if (isApiCallErrorLike(err)) {
    return new ChatStreamError(err.message, {
      status: err.statusCode,
      retryAfter: err.responseHeaders?.["retry-after"],
      cause: err,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new ChatStreamError(message, { cause: err });
}
