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

let lastCacheSafeParams: CacheSafeParams | null = null;

export function saveCacheSafeParams(params: CacheSafeParams | null): void {
  lastCacheSafeParams = params;
}

export function getLastCacheSafeParams(): CacheSafeParams | null {
  return lastCacheSafeParams;
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
