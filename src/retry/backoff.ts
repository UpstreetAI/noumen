const DEFAULT_BASE_DELAY_MS = 500;

/**
 * Compute retry delay with exponential backoff and jitter.
 * If a Retry-After header value is provided (seconds), it takes precedence.
 * Ported from claude-code's getRetryDelay with the same formula.
 */
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs: number = 32000,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds)) {
      return Math.min(seconds * 1000, maxDelayMs);
    }
  }

  const baseDelay = Math.min(
    baseDelayMs * Math.pow(2, attempt - 1),
    maxDelayMs,
  );
  const jitter = Math.random() * 0.25 * baseDelay;
  return baseDelay + jitter;
}

/**
 * Sleep that respects an AbortSignal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
