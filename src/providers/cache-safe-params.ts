/**
 * Cache-safe parameters for subagent prompt cache sharing.
 *
 * When a subagent (fork) shares the same system prompt, model, tools, and
 * thinking config as its parent, both can share the same prompt cache
 * prefix. CacheSafeParams captures these values so the child thread can
 * inherit them and avoid cache breaks.
 */

import type { ToolDefinition } from "./types.js";
import type { ThinkingConfig } from "../thinking/types.js";

export interface CacheSafeParams {
  systemPrompt: string;
  model: string;
  tools: ToolDefinition[];
  thinking?: ThinkingConfig;
}

const cacheSafeParamsMap = new Map<string, CacheSafeParams>();

export function saveCacheSafeParams(params: CacheSafeParams | null, sessionId = "_default"): void {
  if (params) {
    cacheSafeParamsMap.set(sessionId, params);
  } else {
    cacheSafeParamsMap.delete(sessionId);
  }
}

export function getLastCacheSafeParams(sessionId = "_default"): CacheSafeParams | null {
  return cacheSafeParamsMap.get(sessionId) ?? null;
}

export function createCacheSafeParams(opts: {
  systemPrompt: string;
  model: string;
  tools: ToolDefinition[];
  thinking?: ThinkingConfig;
}): CacheSafeParams {
  return {
    systemPrompt: opts.systemPrompt,
    model: opts.model,
    tools: opts.tools,
    thinking: opts.thinking,
  };
}
