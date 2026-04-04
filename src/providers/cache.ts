/**
 * Provider-agnostic prompt caching utilities.
 *
 * Stable tool ordering prevents cache invalidation when the tool set is
 * unchanged. The breakpoint index helper determines which message gets a
 * single cache_control marker per request (matching claude-code's strategy).
 */

import type { ToolDefinition } from "./types.js";
import type { ChatMessage } from "../session/types.js";

export type CacheScope = "global" | "org";

export interface CacheControlConfig {
  enabled: boolean;
  /** TTL for cached content. When set, produces `ttl: '1h'` in cache_control. */
  ttl?: "1h";
  /** Scope for shared cache across sessions/orgs. */
  scope?: CacheScope;
}

/**
 * Sort tool definitions deterministically for prompt cache stability.
 *
 * Strategy (matching claude-code's assembleToolPool): built-in tools form a
 * contiguous prefix sorted by name, followed by MCP/external tools sorted by
 * name. Tools with `mcpInfo` on the original Tool object are treated as MCP;
 * everything else is built-in. Since ToolDefinition doesn't carry mcpInfo,
 * callers can pass an optional set of MCP tool names to partition correctly.
 */
export function sortToolDefinitionsForCache(
  tools: ToolDefinition[],
  mcpToolNames?: ReadonlySet<string>,
): ToolDefinition[] {
  const byName = (a: ToolDefinition, b: ToolDefinition) =>
    a.function.name.localeCompare(b.function.name);

  if (!mcpToolNames || mcpToolNames.size === 0) {
    return [...tools].sort(byName);
  }

  const builtIn: ToolDefinition[] = [];
  const mcp: ToolDefinition[] = [];

  for (const t of tools) {
    if (mcpToolNames.has(t.function.name)) {
      mcp.push(t);
    } else {
      builtIn.push(t);
    }
  }

  return [...builtIn.sort(byName), ...mcp.sort(byName)];
}

/**
 * Determine which message index should receive the cache_control breakpoint.
 *
 * Exactly one message per request is marked. Normally the last message;
 * for forked agents with skipCacheWrite the second-to-last so the fork
 * doesn't write its own tail into the cache.
 */
export function getMessageCacheBreakpointIndex(
  messages: ChatMessage[],
  skipCacheWrite?: boolean,
): number {
  if (messages.length === 0) return -1;
  return skipCacheWrite && messages.length >= 2
    ? messages.length - 2
    : messages.length - 1;
}
