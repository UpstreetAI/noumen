/**
 * AI-generated session title helper.
 *
 * Given a short prompt sourced from recent messages, ask a provider to
 * produce a 3–7 word sentence-case title suitable for a session list.
 *
 * This is a pure helper: it never touches the filesystem and never knows
 * about `SessionStorage`. Callers (e.g. `Agent.autoTitleIfMissing`) own
 * persistence and event emission.
 */

import type { AIProvider, ChatParams } from "../providers/types.js";
import type { ChatMessage, ContentPart } from "./types.js";

/**
 * Config for the Agent's opt-in auto-title feature.
 *
 * Pass `true` for defaults (use the Agent's own provider + its
 * `defaultModel`). Pass an object to customise the provider, model,
 * system prompt, or input cap.
 */
export interface AutoTitleConfig {
  /** Master switch. Default false on `AgentOptions.autoTitle`. */
  enabled?: boolean;
  /**
   * Override provider used for title generation. Falls back to the
   * Agent's main provider.
   */
  provider?: AIProvider;
  /**
   * Override model (e.g. `"claude-haiku-4-5"`). Falls back to the
   * provider's `defaultModel`.
   */
  model?: string;
  /** Override system prompt. */
  systemPrompt?: string;
  /** Cap on seed-text characters. Defaults to 2 000. */
  maxInputChars?: number;
}

/** Default cap on characters fed to the title model. */
export const DEFAULT_AUTO_TITLE_MAX_INPUT_CHARS = 2_000;

/**
 * System prompt for the auto-title generator. Mirrors the shape used by
 * Claude Code so that output quality is familiar.
 */
export const DEFAULT_AUTO_TITLE_SYSTEM_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`;

export interface GenerateAutoTitleOptions {
  provider: AIProvider;
  /** Model override. When omitted, uses `provider.defaultModel`. */
  model?: string;
  /** System prompt override. Falls back to the built-in prompt. */
  systemPrompt?: string;
  /** Character cap on the flattened input. Defaults to 2 000. */
  maxInputChars?: number;
  signal?: AbortSignal;
}

/**
 * Flatten recent user + assistant text into a single block of plain text
 * suitable for the title model. Tool results are skipped; image parts
 * are skipped; only the tail of the concatenated text is kept when long
 * so the most recent context wins.
 */
export function extractTitleSeedText(
  messages: ChatMessage[],
  maxChars: number = DEFAULT_AUTO_TITLE_MAX_INPUT_CHARS,
): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const content = msg.content;
    if (content === null || content === undefined) continue;
    if (typeof content === "string") {
      if (content.trim()) parts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content as ContentPart[]) {
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text.trim()) parts.push(block.text);
        }
      }
    }
  }
  const text = parts.join("\n").trim();
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

/**
 * Attempt to pull a title out of a free-form model response.
 *
 * Strategy, cheapest-first:
 *   1. Parse the whole string as JSON; return `.title` if present.
 *   2. Slice out the first `{...}` block and `JSON.parse` that.
 *   3. Fall back to the first bare quoted substring in the response.
 *
 * Going through `JSON.parse` (instead of a bespoke regex-unescape) means
 * `\n`, `\\`, `\uXXXX`, and any other valid JSON string escapes round-trip
 * correctly — the previous regex only handled `\"`.
 */
export function extractTitleFromResponse(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  type ParseOutcome =
    | { kind: "ok"; title: string }
    | { kind: "empty" } // JSON parsed but `title` was missing / bad / empty
    | { kind: "none" }; // not valid JSON — try the next strategy
  const parseTitle = (s: string): ParseOutcome => {
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      return { kind: "none" };
    }
    if (obj && typeof obj === "object" && "title" in obj) {
      const v = (obj as { title: unknown }).title;
      if (typeof v === "string") {
        const t = v.trim();
        if (t) return { kind: "ok", title: t };
      }
    }
    return { kind: "empty" };
  };

  const whole = parseTitle(trimmed);
  if (whole.kind === "ok") return whole.title;
  if (whole.kind === "empty") return null;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = parseTitle(trimmed.slice(start, end + 1));
    if (sliced.kind === "ok") return sliced.title;
    if (sliced.kind === "empty") return null;
  }

  const quoteMatch = trimmed.match(/"([^"\\]{2,120})"/);
  if (quoteMatch?.[1]) return quoteMatch[1].trim();

  return null;
}

/**
 * Drive the provider once to produce a session title. Returns null on
 * empty seed text, empty model output, or provider errors (callers decide
 * whether to retry — this helper never throws).
 */
/**
 * Output-token budget for a single title round-trip.
 *
 * 60 used to be plenty for classical chat models — the model emits the
 * JSON in ~15 tokens and stops. But reasoning models (OpenAI GPT-5 /
 * o-series, Gemini 2.5 with default-on thinking) count *internal
 * reasoning tokens* against the same budget. A 60-token cap routinely
 * gets consumed entirely on reasoning before any content delta is
 * emitted, producing empty streams.
 *
 * 512 is comfortably above the thinking-minimum most reasoning models
 * need to produce a short title while staying cheap.
 */
const AUTO_TITLE_MAX_OUTPUT_TOKENS = 512;

export async function generateAutoTitle(
  messages: ChatMessage[],
  opts: GenerateAutoTitleOptions,
): Promise<string | null> {
  const seed = extractTitleSeedText(messages, opts.maxInputChars);
  if (!seed) {
    console.warn(
      "[noumen/auto-title] skipped: empty seed text",
      { messageCount: messages.length },
    );
    return null;
  }

  const model = opts.model ?? opts.provider.defaultModel;
  if (!model) {
    console.warn(
      "[noumen/auto-title] skipped: no model resolved (opts.model and provider.defaultModel are both unset)",
    );
    return null;
  }

  const system = opts.systemPrompt ?? DEFAULT_AUTO_TITLE_SYSTEM_PROMPT;

  const params: ChatParams = {
    model,
    system,
    messages: [{ role: "user", content: seed }],
    max_tokens: AUTO_TITLE_MAX_OUTPUT_TOKENS,
    // Keep reasoning cost on this auxiliary round-trip minimal. OpenAI
    // GPT-5 / o-series honor this via `reasoning_effort`; other
    // providers ignore the field.
    reasoningEffort: "minimal",
    // Explicitly disable Gemini 2.5's default-on thinking — otherwise
    // the flash variant burns the whole output budget on reasoning and
    // yields an empty content stream. Providers without a thinking
    // knob ignore this.
    thinking: { type: "disabled" },
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
      name: "session_title",
      strict: true,
    },
    signal: opts.signal,
  };

  let text = "";
  try {
    for await (const chunk of opts.provider.chat(params)) {
      for (const choice of chunk.choices) {
        const delta = choice.delta.content;
        if (typeof delta === "string") text += delta;
      }
    }
  } catch (err) {
    // Swallowing the error entirely leaves the caller with no signal of
    // *why* we have no title, which is the main reason auto-titling
    // quietly breaks in production (invalid model id, missing key, org
    // policy blocking structured outputs, etc). Log and move on so the
    // caller can still treat this as a soft failure.
    console.warn("[noumen/auto-title] provider call failed", {
      model,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!text) {
    console.warn(
      "[noumen/auto-title] provider returned no content",
      { model },
    );
    return null;
  }

  const extracted = extractTitleFromResponse(text) ?? text.trim();
  const normalized = normalizeTitle(extracted);
  if (!normalized) {
    console.warn(
      "[noumen/auto-title] provider response did not contain a usable title",
      { model, rawChars: text.length, rawHead: text.slice(0, 160) },
    );
  }
  return normalized;
}

/**
 * Trim, collapse whitespace, strip wrapping quotes, clamp length.
 * Returns null if the cleaned string would be empty.
 */
export function normalizeTitle(raw: string): string | null {
  if (!raw) return null;
  let t = raw.replace(/\s+/g, " ").trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'")))
  ) {
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/\.+$/, "").trim();
  if (!t) return null;
  if (t.length > 120) t = t.slice(0, 120).trim();
  return t;
}
