/**
 * JSON repair helpers for LLM-emitted tool-call arguments.
 *
 * Ported from mastra (`packages/core/src/stream/aisdk/v5/transform.ts`) so
 * every AI SDK provider noumen talks to goes through the same robust parsing
 * path. Upstream tests live in mastra; vectors are mirrored in our own
 * `ai-sdk-adversarial.test.ts` so regressions surface locally.
 */

/**
 * Sanitizes tool-call input strings for safe JSON parsing.
 *
 * Some LLMs append internal tokens like `<|call|>`, `<|endoftext|>`, or
 * `<|end|>` to otherwise valid JSON in streamed tool-call arguments, causing
 * `JSON.parse` to fail. This function first tries `JSON.parse` on the
 * original input — if parsing succeeds, the input is returned unchanged so
 * legitimate `<|...|>` patterns inside JSON string values are preserved.
 * Only when the original input is not valid JSON does the function fall
 * back to stripping `<|...|>` token patterns and surrounding whitespace.
 */
export function sanitizeToolCallInput(input: string): string {
  try {
    JSON.parse(input);
    return input;
  } catch {
    return input.replace(/[\s]*<\|[^|]*\|>[\s]*/g, "").trim();
  }
}

/**
 * Attempts to repair common JSON malformations produced by LLM providers.
 *
 * Repairs applied in order:
 * 1. Missing quote before property name: `{"a":"b",c":"d"}` -> `{"a":"b","c":"d"}`
 * 2. Unquoted property names: `{command:"value"}` -> `{"command":"value"}`
 * 3. Single quotes -> double quotes
 * 4. Trailing commas: `{"a":1,}` -> `{"a":1}`
 * 5. Unquoted ISO dates/datetimes
 *
 * @returns The parsed object if repair succeeds, or `null` if unrecoverable.
 */
export function tryRepairJson(input: string): Record<string, unknown> | null {
  let repaired = input.trim();

  // Fix 1: Missing quote before property name after `,` or `{`.
  repaired = repaired.replace(
    /([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)"/g,
    (match, prefix, name) => {
      if (prefix.trimEnd().endsWith('"')) return match;
      return `${prefix}"${name}"`;
    },
  );

  // Fix 2: Unquoted property names.
  repaired = repaired.replace(
    /([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g,
    '$1"$2":',
  );

  // Fix 3: Single quotes -> double quotes.
  repaired = repaired.replace(/'/g, '"');

  // Fix 4: Trailing commas before closing braces/brackets.
  repaired = repaired.replace(/,(\s*[}\]])/g, "$1");

  // Fix 5: Unquoted ISO date/datetime values.
  repaired = repaired.replace(
    /:\s*(\d{4}-\d{2}-\d{2}(?:T[\d:]+)?)\s*([,}])/g,
    ': "$1"$2',
  );

  try {
    return JSON.parse(repaired) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Parse tool-call JSON the same way mastra does, with sanitize + repair
 * fallback. Returns `undefined` if the string is empty; returns `null`
 * when the JSON is unrecoverable (callers typically drop the tool call).
 */
export function parseToolCallJson(input: string): Record<string, unknown> | null | undefined {
  if (!input) return undefined;
  const sanitized = sanitizeToolCallInput(input);
  if (!sanitized) return undefined;
  try {
    return JSON.parse(sanitized) as Record<string, unknown>;
  } catch {
    return tryRepairJson(sanitized);
  }
}
