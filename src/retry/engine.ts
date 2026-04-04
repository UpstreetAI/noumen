import type { ChatStreamChunk } from "../providers/types.js";
import type { StreamEvent } from "../session/types.js";
import type { RetryEngineOptions, RetryContext } from "./types.js";
import { classifyError, isRetryable } from "./classify.js";
import { getRetryDelay, sleep } from "./backoff.js";

const FLOOR_OUTPUT_TOKENS = 3000;

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = "CannotRetryError";
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`);
    this.name = "FallbackTriggeredError";
  }
}

/**
 * Retry engine that wraps a stream-creating operation.
 * Yields retry_attempt events while waiting, then returns the stream on success.
 *
 * The operation receives a RetryContext that may include a maxTokensOverride
 * (after context overflow) or a different model (after fallback).
 */
export async function* withRetry(
  operation: (ctx: RetryContext) => AsyncIterable<ChatStreamChunk>,
  options: RetryEngineOptions,
): AsyncGenerator<StreamEvent, AsyncIterable<ChatStreamChunk>> {
  const maxRetries = options.maxRetries ?? 10;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 32000;
  const maxConsecutiveOverloaded = options.maxConsecutiveOverloaded ?? 3;

  const retryContext: RetryContext = {
    attempt: 0,
    model: options.model,
  };

  let consecutiveOverloaded = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    retryContext.attempt = attempt;

    try {
      const stream = operation(retryContext);

      // Try to get the first chunk to detect immediate errors.
      // If the stream itself throws, we catch it in the retry loop.
      const iterator = toAsyncIterator(stream);
      const first = await iterator.next();

      if (first.done) {
        return emptyStream();
      }

      return prependChunk(first.value, iterator);
    } catch (error) {
      lastError = error;

      const classified = classifyError(error);

      // Context overflow: adjust max_tokens and retry
      if (classified.isContextOverflow && classified.contextOverflowData) {
        const { inputTokens, contextLimit } = classified.contextOverflowData;
        const safetyBuffer = 1000;
        const available = Math.max(0, contextLimit - inputTokens - safetyBuffer);

        if (available < FLOOR_OUTPUT_TOKENS) {
          throw new CannotRetryError(error, retryContext);
        }

        const minRequired = (options.thinkingBudget ?? 0) + 1;
        retryContext.maxTokensOverride = Math.max(
          FLOOR_OUTPUT_TOKENS,
          available,
          minRequired,
        );

        continue;
      }

      // Track consecutive overloaded for fallback
      if (classified.isOverloaded) {
        consecutiveOverloaded++;
        if (
          consecutiveOverloaded >= maxConsecutiveOverloaded &&
          options.fallbackModel
        ) {
          const previousModel = retryContext.model;
          retryContext.model = options.fallbackModel;
          consecutiveOverloaded = 0;

          yield {
            type: "retry_attempt",
            attempt,
            maxRetries,
            delayMs: 0,
            error: new Error(
              `Model fallback: ${previousModel} → ${options.fallbackModel} after ${maxConsecutiveOverloaded} consecutive overloaded errors`,
            ),
          };
        }
      } else {
        consecutiveOverloaded = 0;
      }

      if (!isRetryable(classified, options)) {
        throw new CannotRetryError(error, retryContext);
      }

      if (attempt > maxRetries) {
        const exhaustedError = error instanceof Error ? error : new Error(String(error));
        yield {
          type: "retry_exhausted",
          attempts: attempt,
          error: exhaustedError,
        };
        throw new CannotRetryError(error, retryContext);
      }

      const delayMs = getRetryDelay(
        attempt,
        classified.retryAfter,
        maxDelayMs,
      );

      const retryError = error instanceof Error ? error : new Error(String(error));

      options.onRetry?.(attempt, retryError, delayMs);

      yield {
        type: "retry_attempt",
        attempt,
        maxRetries,
        delayMs,
        error: retryError,
      };

      await sleep(delayMs, options.signal);
    }
  }

  throw new CannotRetryError(lastError, retryContext);
}

async function* emptyStream(): AsyncIterable<ChatStreamChunk> {
  // yields nothing
}

function toAsyncIterator<T>(
  iterable: AsyncIterable<T>,
): AsyncIterator<T> {
  return iterable[Symbol.asyncIterator]();
}

async function* prependChunk(
  first: ChatStreamChunk,
  rest: AsyncIterator<ChatStreamChunk>,
): AsyncIterable<ChatStreamChunk> {
  yield first;
  let next = await rest.next();
  while (!next.done) {
    yield next.value;
    next = await rest.next();
  }
}
