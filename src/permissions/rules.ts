import * as path from "node:path";
import * as fs from "node:fs";
import type {
  PermissionBehavior,
  PermissionContext,
  PermissionRule,
} from "./types.js";
import { RULE_SOURCE_PRECEDENCE } from "./types.js";
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

const SAFE_WRAPPERS = ["timeout", "time", "nice", "nohup", "stdbuf"];

const COMPOUND_OPERATORS_RE = /\s*(?:;|&&|\|\||\|)\s*/;

/**
 * Strip leading env var assignments and safe wrapper commands from a
 * shell command so that deny/ask rules match the underlying command.
 */
export function stripForRuleMatching(command: string): string {
  let cmd = command.trim();
  // Strip env var prefixes
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd)) {
    cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  // Strip safe wrapper commands (and their flags)
  let changed = true;
  while (changed) {
    changed = false;
    for (const wrapper of SAFE_WRAPPERS) {
      if (cmd.startsWith(wrapper + " ")) {
        cmd = cmd.slice(wrapper.length).trim();
        // Skip flags belonging to the wrapper
        while (cmd.startsWith("-")) {
          const spaceIdx = cmd.indexOf(" ");
          if (spaceIdx === -1) break;
          cmd = cmd.slice(spaceIdx).trim();
        }
        // Strip another round of env vars after the wrapper
        while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd)) {
          cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
        }
        changed = true;
      }
    }
  }
  return cmd;
}

function isCompoundCommand(content: string): boolean {
  return COMPOUND_OPERATORS_RE.test(content);
}

/**
 * Match a content string against a rule's `ruleContent`.
 *
 * Three match modes (following claude-code's bash/filesystem patterns):
 *  - **exact**: `ruleContent === content`
 *  - **prefix**: `ruleContent` ends with `:*` → prefix match
 *  - **glob**: `ruleContent` contains `*` or `**` → simple glob match
 *
 * For deny/ask rules, also tries matching after stripping env vars and
 * safe wrapper commands from the content.
 */
export function contentMatchesRule(
  content: string,
  ruleContent: string,
): boolean {
  if (ruleContent.endsWith(":*")) {
    const prefix = ruleContent.slice(0, -2);
    const matches = content === prefix || content.startsWith(prefix + " ");
    if (matches && isCompoundCommand(content)) return false;
    if (matches) return true;
    // Retry after stripping env vars / wrappers
    const stripped = stripForRuleMatching(content);
    if (stripped !== content) {
      const strippedMatches = stripped === prefix || stripped.startsWith(prefix + " ");
      if (strippedMatches && isCompoundCommand(stripped)) return false;
      return strippedMatches;
    }
    return false;
  }

  if (ruleContent.includes("*")) {
    if (matchSimpleGlob(ruleContent, content)) return true;
    const stripped = stripForRuleMatching(content);
    if (stripped !== content) return matchSimpleGlob(ruleContent, stripped);
    return false;
  }

  if (ruleContent === content) return true;
  const stripped = stripForRuleMatching(content);
  return stripped !== content && ruleContent === stripped;
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
  const matched = context.rules.filter((rule) => {
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

  // Sort by source precedence so higher-precedence sources win first
  matched.sort((a, b) => {
    const aIdx = a.source ? RULE_SOURCE_PRECEDENCE.indexOf(a.source) : RULE_SOURCE_PRECEDENCE.length;
    const bIdx = b.source ? RULE_SOURCE_PRECEDENCE.indexOf(b.source) : RULE_SOURCE_PRECEDENCE.length;
    return aIdx - bIdx;
  });

  return matched;
}

/**
 * Reject paths that contain shell expansion syntax which could cause TOCTOU
 * issues — the path resolves differently in Node vs when the shell evaluates it.
 */
export function containsShellExpansion(p: string): boolean {
  if (p.includes("$") || p.includes("%") || p.startsWith("=")) return true;
  if (/^~[^/]/.test(p)) return true; // ~user, ~+, ~- (bare ~/... is fine)
  if (p.startsWith("\\\\")) return true; // UNC paths
  return false;
}

/**
 * Check whether a file path falls within any of the configured working directories.
 */
export function isPathInWorkingDirectories(
  filePath: string,
  workingDirectories: string[],
): boolean {
  if (workingDirectories.length === 0) return false;
  if (containsShellExpansion(filePath)) return false;

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
  try {
    result = fs.realpathSync(result);
  } catch {
    // Path doesn't exist yet — fall through to the resolved path
  }
  while (result.endsWith("/") && result.length > 1) {
    result = result.slice(0, -1);
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    result = result.toLowerCase();
  }
  return result;
}
