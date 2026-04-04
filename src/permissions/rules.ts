import * as path from "node:path";
import type {
  PermissionBehavior,
  PermissionContext,
  PermissionRule,
} from "./types.js";
/**
 * Check whether a tool name matches a rule's `toolName` field.
 *
 * Supports:
 *  - Exact match: `"Bash"` matches `"Bash"`
 *  - MCP server-level wildcard: rule `"mcp__myserver"` matches any tool
 *    on that server (e.g. `"mcp__myserver__sometool"`)
 */
export function toolMatchesRule(
  toolName: string,
  rule: PermissionRule,
  mcpInfo?: { serverName: string; toolName: string },
): boolean {
  if (rule.toolName === toolName) return true;

  if (mcpInfo) {
    const serverPrefix = parseMcpServerPrefix(rule.toolName);
    if (serverPrefix && serverPrefix === mcpInfo.serverName) {
      return true;
    }
  }

  return false;
}

/**
 * Parse a server-level MCP rule like `"mcp__myserver"` (no tool suffix)
 * and return the server name, or `null` if it has a tool component or
 * doesn't match the MCP prefix pattern.
 */
function parseMcpServerPrefix(ruleName: string): string | null {
  const parts = ruleName.split("__");
  if (parts.length !== 2 || parts[0] !== "mcp" || !parts[1]) return null;
  return parts[1];
}

/**
 * Match a content string against a rule's `ruleContent`.
 *
 * Three match modes (following claude-code's bash/filesystem patterns):
 *  - **exact**: `ruleContent === content`
 *  - **prefix**: `ruleContent` ends with `:*` → prefix match
 *  - **glob**: `ruleContent` contains `*` or `**` → simple glob match
 */
export function contentMatchesRule(
  content: string,
  ruleContent: string,
): boolean {
  if (ruleContent.endsWith(":*")) {
    const prefix = ruleContent.slice(0, -2);
    return content === prefix || content.startsWith(prefix + " ");
  }

  if (ruleContent.includes("*")) {
    return matchSimpleGlob(ruleContent, content);
  }

  return ruleContent === content;
}

/**
 * Minimal glob matching for file-path rules.
 *
 * Supports `*` (any non-separator chars) and `**` (any chars including `/`).
 * Anchored: the entire string must match.
 */
export function matchSimpleGlob(pattern: string, value: string): boolean {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += 2;
      if (pattern[i] === "/") i++;
    } else if (pattern[i] === "*") {
      regex += "[^/]*";
      i++;
    } else if (pattern[i] === "?") {
      regex += "[^/]";
      i++;
    } else {
      regex += escapeRegex(pattern[i]!);
      i++;
    }
  }
  regex += "$";

  return new RegExp(regex).test(value);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return all rules in `context` that match the given tool and behavior,
 * optionally filtered by content.
 */
export function getMatchingRules(
  context: PermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
  content?: string,
  mcpInfo?: { serverName: string; toolName: string },
): PermissionRule[] {
  return context.rules.filter((rule) => {
    if (rule.behavior !== behavior) return false;
    if (!toolMatchesRule(toolName, rule, mcpInfo)) return false;

    if (rule.ruleContent !== undefined) {
      if (content === undefined) return false;
      return contentMatchesRule(content, rule.ruleContent);
    }

    // Whole-tool rule (no ruleContent) — matches when no content filter
    // is requested, or always matches if content IS provided (whole-tool
    // rules override content-specific ones, matching claude-code behavior).
    return true;
  });
}

/**
 * Check whether a file path falls within any of the configured working directories.
 */
export function isPathInWorkingDirectories(
  filePath: string,
  workingDirectories: string[],
): boolean {
  if (workingDirectories.length === 0) return false;

  const normalized = normalizePath(filePath);
  return workingDirectories.some((dir) => {
    const normalizedDir = normalizePath(dir);
    return (
      normalized === normalizedDir ||
      normalized.startsWith(normalizedDir + "/")
    );
  });
}

function normalizePath(p: string): string {
  let result = path.resolve(p);
  while (result.endsWith("/") && result.length > 1) {
    result = result.slice(0, -1);
  }
  return result;
}
