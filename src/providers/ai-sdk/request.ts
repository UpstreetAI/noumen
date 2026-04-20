/**
 * `ChatParams` -> `LanguageModelV3CallOptions` translation.
 *
 * Handles:
 * - OpenAI-shaped `ChatMessage`s -> AI SDK `LanguageModelV3Prompt`
 * - Anthropic thinking signature / redacted thinking round-tripping via
 *   `providerOptions.anthropic` on reasoning parts
 * - Anthropic cache breakpoints on tools + messages (honors `skipCacheWrite`)
 * - `thinking` / `reasoningEffort` mapped to the right
 *   `providerOptions.{anthropic,openai,google}` shape per provider family
 * - Tool definitions with `fixTypelessProperties` to satisfy OpenAI's
 *   strict JSON Schema validator
 */

import type { ChatMessage, ContentPart } from "../../session/types.js";
import type { ChatParams, ToolDefinition } from "../types.js";
import type { CacheControlConfig } from "../cache.js";
import { getMessageCacheBreakpointIndex } from "../cache.js";
import { fixTypelessProperties } from "./compat/schema.js";
import type { ProviderFamily } from "./provider-family.js";

/**
 * Minimal subset of `LanguageModelV3CallOptions` that we produce. We avoid
 * importing `@ai-sdk/provider` types at the module level so mock language
 * models in tests don't need to ship the full generic type surface; the
 * returned object is structurally compatible.
 */
export interface TranslatedCallOptions {
  prompt: AiSdkMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  tools?: AiSdkTool[];
  toolChoice?: { type: "auto" };
  responseFormat?:
    | { type: "text" }
    | { type: "json"; schema?: Record<string, unknown>; name?: string };
  providerOptions?: Record<string, Record<string, unknown>>;
}

export type AiSdkMessage =
  | { role: "system"; content: string; providerOptions?: Record<string, Record<string, unknown>> }
  | {
      role: "user";
      content: Array<AiSdkTextPart | AiSdkFilePart>;
      providerOptions?: Record<string, Record<string, unknown>>;
    }
  | {
      role: "assistant";
      content: Array<AiSdkTextPart | AiSdkReasoningPart | AiSdkToolCallPart>;
      providerOptions?: Record<string, Record<string, unknown>>;
    }
  | {
      role: "tool";
      content: AiSdkToolResultPart[];
      providerOptions?: Record<string, Record<string, unknown>>;
    };

export interface AiSdkTextPart {
  type: "text";
  text: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface AiSdkFilePart {
  type: "file";
  data: string | Uint8Array | URL;
  mediaType: string;
  filename?: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface AiSdkReasoningPart {
  type: "reasoning";
  text: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface AiSdkToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface AiSdkToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output:
    | { type: "text"; value: string }
    | { type: "json"; value: unknown }
    | { type: "error-text"; value: string }
    | {
        type: "content";
        value: Array<
          | { type: "text"; text: string }
          | { type: "image-data"; data: string; mediaType: string }
          | { type: "image-url"; url: string }
        >;
      };
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface AiSdkTool {
  type: "function";
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  providerOptions?: Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export interface TranslateRequestOptions {
  providerFamily: ProviderFamily;
  /** Opt-in prompt caching config. Only applied when family is `anthropic`. */
  cacheConfig?: CacheControlConfig;
}

export function translateRequest(
  params: ChatParams,
  opts: TranslateRequestOptions,
): TranslatedCallOptions {
  const { providerFamily } = opts;
  const useAnthropicCache =
    providerFamily === "anthropic" && opts.cacheConfig?.enabled === true;

  const prompt = buildPrompt(params, {
    providerFamily,
    cacheConfig: useAnthropicCache ? opts.cacheConfig : undefined,
    skipCacheWrite: params.skipCacheWrite,
  });

  const tools = buildTools(params.tools, {
    providerFamily,
    cacheConfig: useAnthropicCache ? opts.cacheConfig : undefined,
  });

  const call: TranslatedCallOptions = {
    prompt,
    maxOutputTokens: params.max_tokens,
  };

  if (params.signal) call.abortSignal = params.signal;
  if (tools && tools.length > 0) call.tools = tools;

  const thinkingEnabled =
    params.thinking?.type === "enabled" &&
    (params.thinking as { budgetTokens: number }).budgetTokens > 0;

  // Anthropic rejects non-default temperature when thinking is on; replicate
  // the guard from the legacy provider so behavior is identical.
  if (providerFamily === "anthropic") {
    if (!thinkingEnabled && params.temperature !== undefined) {
      call.temperature = params.temperature;
    }
  } else if (params.temperature !== undefined) {
    // OpenAI reasoning models also reject non-default temperature, but the
    // AI SDK's OpenAI provider silently drops it with a warning, so we pass
    // it through and let the SDK decide.
    call.temperature = params.temperature;
  }

  if (params.outputFormat?.type === "json_schema") {
    call.responseFormat = {
      type: "json",
      schema: params.outputFormat.schema,
      name: params.outputFormat.name,
    };
  } else if (params.outputFormat?.type === "json_object") {
    call.responseFormat = { type: "json" };
  }

  const providerOptions = buildProviderOptions(params, providerFamily);
  if (providerOptions) call.providerOptions = providerOptions;

  return call;
}

// ---------------------------------------------------------------------------
// Provider-specific option mapping
// ---------------------------------------------------------------------------

function buildProviderOptions(
  params: ChatParams,
  family: ProviderFamily,
): Record<string, Record<string, unknown>> | undefined {
  const thinking = params.thinking;
  const thinkingEnabled =
    thinking?.type === "enabled" &&
    (thinking as { budgetTokens: number }).budgetTokens > 0;

  switch (family) {
    case "anthropic": {
      if (!thinkingEnabled) {
        // `thinking: { type: "disabled" }` -> omit; Anthropic rejects an
        // explicit disabled object on models that don't support the knob.
        return undefined;
      }
      const { budgetTokens } = thinking as { type: "enabled"; budgetTokens: number };
      const maxOutput = params.max_tokens;
      const clampedBudget =
        typeof maxOutput === "number" && maxOutput > 0
          ? Math.min(budgetTokens, maxOutput - 1)
          : budgetTokens;
      return {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: clampedBudget,
          },
        },
      };
    }

    case "openai": {
      const effort =
        params.reasoningEffort ??
        (thinkingEnabled ? "high" : thinking?.type === "disabled" ? "minimal" : undefined);
      if (!effort) return undefined;
      return { openai: { reasoningEffort: effort } };
    }

    case "google": {
      if (thinkingEnabled) {
        const { budgetTokens } = thinking as { type: "enabled"; budgetTokens: number };
        return { google: { thinkingConfig: { thinkingBudget: budgetTokens } } };
      }
      if (thinking?.type === "disabled") {
        // Gemini 2.5-flash enables thinking by default and eats the output
        // budget. Pin to 0 to disable. Matches the legacy GeminiProvider.
        return { google: { thinkingConfig: { thinkingBudget: 0 } } };
      }
      return undefined;
    }

    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

interface BuildPromptOptions {
  providerFamily: ProviderFamily;
  cacheConfig?: CacheControlConfig;
  skipCacheWrite?: boolean;
}

function buildPrompt(
  params: ChatParams,
  opts: BuildPromptOptions,
): AiSdkMessage[] {
  const result: AiSdkMessage[] = [];

  // Conversation-level filter: drop noumen-internal system messages; the
  // top-level system prompt lives in params.system for historical reasons.
  const convo = params.messages.filter((m) => m.role !== "system");

  const cacheEnabled = opts.cacheConfig?.enabled === true;
  const cacheBreakpoint = cacheEnabled
    ? getMessageCacheBreakpointIndex(convo, opts.skipCacheWrite)
    : -1;

  if (params.system) {
    const sys: AiSdkMessage = { role: "system", content: params.system };
    if (cacheEnabled) {
      sys.providerOptions = {
        anthropic: { cacheControl: buildCacheControl(opts.cacheConfig!) },
      };
    }
    result.push(sys);
  }

  for (let i = 0; i < convo.length; i++) {
    const msg = convo[i];
    const addCache = cacheEnabled && i === cacheBreakpoint;

    if (msg.role === "user") {
      result.push(convertUserMessage(msg, addCache ? opts.cacheConfig : undefined));
    } else if (msg.role === "assistant") {
      result.push(
        convertAssistantMessage(msg, {
          addCache,
          cacheConfig: opts.cacheConfig,
          providerFamily: opts.providerFamily,
        }),
      );
    } else if (msg.role === "tool") {
      result.push(
        convertToolMessage(msg, addCache ? opts.cacheConfig : undefined),
      );
    }
  }

  return result;
}

function convertUserMessage(
  msg: Extract<ChatMessage, { role: "user" }>,
  cacheConfig: CacheControlConfig | undefined,
): AiSdkMessage {
  const parts: Array<AiSdkTextPart | AiSdkFilePart> = Array.isArray(msg.content)
    ? contentPartsToAiSdk(msg.content)
    : [{ type: "text", text: msg.content }];

  if (cacheConfig?.enabled && parts.length > 0) {
    const last = parts[parts.length - 1];
    last.providerOptions = {
      ...(last.providerOptions ?? {}),
      anthropic: { cacheControl: buildCacheControl(cacheConfig) },
    };
  }

  return { role: "user", content: parts };
}

interface AssistantConvertOptions {
  addCache: boolean;
  cacheConfig?: CacheControlConfig;
  providerFamily: ProviderFamily;
}

function convertAssistantMessage(
  msg: Extract<ChatMessage, { role: "assistant" }>,
  opts: AssistantConvertOptions,
): AiSdkMessage {
  const content: Array<AiSdkTextPart | AiSdkReasoningPart | AiSdkToolCallPart> = [];

  // Anthropic requires the thinking block back verbatim (including
  // signature) for cache continuity. Other providers ignore it — the
  // AI SDK forwards reasoning parts only when the provider knows how to
  // handle them.
  if (msg.thinking_content && opts.providerFamily === "anthropic") {
    const reasoning: AiSdkReasoningPart = {
      type: "reasoning",
      text: msg.thinking_content,
    };
    if (msg.thinking_signature) {
      reasoning.providerOptions = {
        anthropic: { signature: msg.thinking_signature },
      };
    }
    content.push(reasoning);
  }

  if (msg.redacted_thinking_data && opts.providerFamily === "anthropic") {
    // AI SDK models redacted thinking as a reasoning part with
    // `redactedData` in providerOptions. The text is empty because the
    // provider only needs the opaque payload to reconstruct the block.
    content.push({
      type: "reasoning",
      text: "",
      providerOptions: {
        anthropic: { redactedData: msg.redacted_thinking_data },
      },
    });
  }

  if (typeof msg.content === "string" && msg.content !== "") {
    content.push({ type: "text", text: msg.content });
  } else if (
    msg.content != null &&
    typeof msg.content !== "string" &&
    Array.isArray(msg.content)
  ) {
    for (const part of msg.content as ContentPart[]) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
    }
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: unknown = {};
      if (tc.function.arguments) {
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          // Truncated / malformed — send empty object so providers accept
          // the turn; the error will already have surfaced via the stream.
          input = {};
        }
      }
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: tc.function.name,
        input,
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  if (opts.addCache && opts.cacheConfig?.enabled) {
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block.type === "reasoning") continue;
      block.providerOptions = {
        ...(block.providerOptions ?? {}),
        anthropic: { cacheControl: buildCacheControl(opts.cacheConfig) },
      };
      break;
    }
  }

  return { role: "assistant", content };
}

function convertToolMessage(
  msg: Extract<ChatMessage, { role: "tool" }>,
  cacheConfig: CacheControlConfig | undefined,
): AiSdkMessage {
  const output: AiSdkToolResultPart["output"] = Array.isArray(msg.content)
    ? toolContentToOutput(msg.content as ContentPart[], msg.isError)
    : msg.isError
      ? { type: "error-text", value: msg.content }
      : { type: "text", value: msg.content };

  const part: AiSdkToolResultPart = {
    type: "tool-result",
    toolCallId: msg.tool_call_id,
    toolName: "tool",
    output,
  };

  if (cacheConfig?.enabled) {
    part.providerOptions = {
      anthropic: { cacheControl: buildCacheControl(cacheConfig) },
    };
  }

  return { role: "tool", content: [part] };
}

// ---------------------------------------------------------------------------
// Content part conversion
// ---------------------------------------------------------------------------

function contentPartsToAiSdk(parts: ContentPart[]): Array<AiSdkTextPart | AiSdkFilePart> {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text } as AiSdkTextPart;
    }
    if (part.type === "image") {
      return {
        type: "file",
        mediaType: part.media_type,
        data: part.data,
      } as AiSdkFilePart;
    }
    return {
      type: "file",
      mediaType: "image/*",
      data: new URL(part.url),
    } as AiSdkFilePart;
  });
}

function toolContentToOutput(
  parts: ContentPart[],
  isError: boolean | undefined,
): AiSdkToolResultPart["output"] {
  const contentValue: Array<
    | { type: "text"; text: string }
    | { type: "image-data"; data: string; mediaType: string }
    | { type: "image-url"; url: string }
  > = parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image") {
      return { type: "image-data", data: p.data, mediaType: p.media_type };
    }
    return { type: "image-url", url: p.url };
  });

  if (isError) {
    const textOnly = contentValue
      .filter((v): v is { type: "text"; text: string } => v.type === "text")
      .map((v) => v.text)
      .join("\n");
    return { type: "error-text", value: textOnly };
  }

  return { type: "content", value: contentValue };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface BuildToolsOptions {
  providerFamily: ProviderFamily;
  cacheConfig?: CacheControlConfig;
}

function buildTools(
  tools: ToolDefinition[] | undefined,
  opts: BuildToolsOptions,
): AiSdkTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const cacheEnabled =
    opts.providerFamily === "anthropic" && opts.cacheConfig?.enabled === true;

  return tools.map((t, idx) => {
    const schema = fixTypelessProperties(
      t.function.parameters as unknown as Record<string, unknown>,
    );
    const tool: AiSdkTool = {
      type: "function",
      name: t.function.name,
      description: t.function.description,
      inputSchema: schema,
    };

    // Anthropic places the cache breakpoint on the *last* tool.
    if (cacheEnabled && idx === tools.length - 1) {
      tool.providerOptions = {
        anthropic: { cacheControl: buildCacheControl(opts.cacheConfig!) },
      };
    }

    return tool;
  });
}

// ---------------------------------------------------------------------------
// Cache control helper
// ---------------------------------------------------------------------------

function buildCacheControl(config: CacheControlConfig): Record<string, unknown> {
  const cc: Record<string, unknown> = { type: "ephemeral" };
  if (config.ttl) cc.ttl = config.ttl;
  if (config.scope) cc.scope = config.scope;
  return cc;
}
