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
 * Attempt to pull a quoted title out of a free-form model response.
 * Handles the common case where the model wraps JSON in prose or code
 * fences without requiring a full JSON parser upstream of us.
 */
export function extractTitleFromResponse(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  const jsonMatch = trimmed.match(/\{[\s\S]*?"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"[\s\S]*?\}/);
  if (jsonMatch?.[1]) {
    const candidate = jsonMatch[1].replace(/\\"/g, '"').trim();
    if (candidate) return candidate;
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
export async function generateAutoTitle(
  messages: ChatMessage[],
  opts: GenerateAutoTitleOptions,
): Promise<string | null> {
  const seed = extractTitleSeedText(messages, opts.maxInputChars);
  if (!seed) return null;

  const model = opts.model ?? opts.provider.defaultModel;
  if (!model) return null;

  const system = opts.systemPrompt ?? DEFAULT_AUTO_TITLE_SYSTEM_PROMPT;

  const params: ChatParams = {
    model,
    system,
    messages: [{ role: "user", content: seed }],
    max_tokens: 60,
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
  } catch {
    return null;
  }

  if (!text) return null;

  const extracted = extractTitleFromResponse(text) ?? text.trim();
  return normalizeTitle(extracted);
}

/**
 * Trim, collapse whitespace, strip wrapping quotes, clamp length.
 * Returns null if the cleaned string would be empty.
 */
export function normalizeTitle(raw: string): string | null {
  if (!raw) return null;
  let t = raw.replace(/\s+/g, " ").trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    t = t.slice(1, -1).trim();
  }
  if (t.endsWith(".")) t = t.slice(0, -1).trim();
  if (!t) return null;
  if (t.length > 120) t = t.slice(0, 120).trim();
  return t;
}
