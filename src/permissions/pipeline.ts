import * as path from "node:path";
import * as fs from "node:fs";
import type { Tool, ToolContext } from "../tools/types.js";
import type { AIProvider } from "../providers/types.js";
import type { ChatMessage } from "../session/types.js";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionResult,
  AutoModeConfig,
} from "./types.js";
import { getMatchingRules, isPathInWorkingDirectories } from "./rules.js";
import { resolveToolFlag } from "../tools/registry.js";
import { classifyPermission } from "./classifier.js";
import type { DenialTracker } from "./denial-tracking.js";
import { splitCompoundCommand } from "../tools/shell-safety/command-classification.js";
import {
  extractContentHint,
  resolveAcceptEditsDecision,
  resolveAutoModeDecision,
} from "./helpers.js";

/**
 * Patterns that are always dangerous regardless of dot-dir configuration.
 * Dot-dir patterns (e.g. `.noumen`, `.claude`) are composed at call time
 * from the caller-supplied `dotDirNames`.
 */
const BASE_DANGEROUS_PATH_PATTERNS = [
  /(?:^|\/)\.git(?:\/|$)/,
  /(?:^|\/)\.bashrc$/,
  /(?:^|\/)\.bash_profile$/,
  /(?:^|\/)\.zshrc$/,
  /(?:^|\/)\.zprofile$/,
  /(?:^|\/)\.profile$/,
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|\/)\.env$/,
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.vscode(?:\/|$)/,
  /(?:^|\/)\.idea(?:\/|$)/,
  /(?:^|\/)\.gitconfig$/,
  /(?:^|\/)\.gitmodules$/,
  /(?:^|\/)\.mcp\.json$/,
  /(?:^|\/)\.ripgreprc$/,
  /(?:^|\/)\.noumen\.json$/,
];

/** Default dot-dirs protected when the caller doesn't specify names. */
const DEFAULT_PROTECTED_DOT_DIRS = [".noumen", ".claude"];

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDangerousPathPatterns(dotDirNames?: string[]): RegExp[] {
  const names = dotDirNames && dotDirNames.length > 0 ? dotDirNames : DEFAULT_PROTECTED_DOT_DIRS;
  const dotDirPatterns = names.map(
    (name) => new RegExp(`(?:^|\\/)${escapeForRegex(name)}(?:\\/|$)`),
  );
  return [...BASE_DANGEROUS_PATH_PATTERNS, ...dotDirPatterns];
}

/**
 * Resolve the permission decision for a tool invocation.
 *
 * Pipeline mirrors claude-code's `hasPermissionsToUseToolInner`:
 *  1. Deny rules for the whole tool
 *  2. Ask rules for the whole tool
 *  3. Tool's own `checkPermissions` (if defined)
 *  4. Mode-based bypass / enforcement
 *  5. Content-specific allow rules
 *  6. Fallback: passthrough → ask
 */
export interface ResolvePermissionOptions {
  provider?: AIProvider;
  model?: string;
  recentMessages?: ChatMessage[];
  autoModeConfig?: AutoModeConfig;
  signal?: AbortSignal;
  denialTracker?: DenialTracker;
}

export async function resolvePermission(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolContext,
  permCtx: PermissionContext,
  opts?: ResolvePermissionOptions,
): Promise<PermissionDecision> {
  const toolName = tool.name;
  const contentHint = extractContentHint(tool, input);

  // 1. Deny rules for whole tool (no ruleContent)
  const wholeDenyRules = getMatchingRules(
    permCtx,
    toolName,
    "deny",
    undefined,
    tool.mcpInfo,
  );
  if (wholeDenyRules.length > 0) {
    return {
      behavior: "deny",
      message: `Tool "${toolName}" is denied by rule.`,
      reason: "rule",
    };
  }

  // 1b. Content-specific deny rules
  if (contentHint !== undefined) {
    const contentDenyRules = getMatchingRules(
      permCtx,
      toolName,
      "deny",
      contentHint,
      tool.mcpInfo,
    );
    if (contentDenyRules.length > 0) {
      return {
        behavior: "deny",
        message: `Tool "${toolName}" with "${contentHint}" is denied by rule.`,
        reason: "rule",
      };
    }
  }

  // 2. Ask rules for whole tool
  const wholeAskRules = getMatchingRules(
    permCtx,
    toolName,
    "ask",
    undefined,
    tool.mcpInfo,
  );
  if (wholeAskRules.length > 0) {
    return {
      behavior: "ask",
      message: `Tool "${toolName}" requires approval.`,
      reason: "rule",
    };
  }

  // 2b. Content-specific ask rules (bypass-immune — user explicitly configured these)
  if (contentHint !== undefined) {
    const contentAskRules = getMatchingRules(
      permCtx,
      toolName,
      "ask",
      contentHint,
      tool.mcpInfo,
    );
    if (contentAskRules.length > 0) {
      return {
        behavior: "ask",
        message: `Tool "${toolName}" with "${contentHint}" requires approval.`,
        reason: "rule",
      };
    }
  }

  // 2c. Dangerous path safety check (bypass-immune)
  const dangerousFilePath =
    typeof input.file_path === "string" ? input.file_path
    : typeof input.path === "string" ? input.path
    : undefined;
  if (dangerousFilePath && isDangerousPath(dangerousFilePath, ctx.cwd, permCtx.dotDirNames)) {
    return {
      behavior: "ask",
      message: `Path "${dangerousFilePath}" targets a sensitive location.`,
      reason: "safetyCheck",
    };
  }

  // 2d. Bash command dangerous path check (bypass-immune)
  if (toolName === "Bash" && typeof input.command === "string") {
    const subCommands = splitCompoundCommand(input.command);
    for (const sub of subCommands) {
      const tokens = sub.trim().split(/\s+/);
      for (const token of tokens) {
        if (token.startsWith("-")) continue;
        if (isDangerousPath(token, ctx.cwd, permCtx.dotDirNames)) {
          return {
            behavior: "ask",
            message: `Bash command references sensitive path "${token}".`,
            reason: "safetyCheck",
          };
        }
      }
    }
  }

  // 3. Tool's own checkPermissions
  let toolResult: PermissionResult | undefined;
  if (tool.checkPermissions) {
    if (opts?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      toolResult = await tool.checkPermissions(input, ctx);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (err instanceof Error && err.name === "AbortError") throw err;
      console.warn(`[noumen/permissions] checkPermissions error for "${toolName}":`, err);
    }

    if (toolResult?.behavior === "deny") {
      return {
        behavior: "deny",
        message: toolResult.message,
        reason: toolResult.reason ?? "tool",
      };
    }
    if (toolResult?.behavior === "ask") {
      const isSafetyCheck = toolResult.reason === "safetyCheck";
      const isInteractive = !!tool.requiresUserInteraction;

      // Bypass-immune: always prompt regardless of mode
      if (isSafetyCheck || isInteractive) {
        return {
          behavior: "ask",
          message: toolResult.message,
          reason: toolResult.reason ?? "tool",
          suggestions: toolResult.suggestions,
        };
      }

      // bypassPermissions skips the tool ask; all other modes fall through
      // so dontAsk can convert to deny and auto can run the classifier.
      if (permCtx.mode !== "bypassPermissions") {
        // toolResult.behavior === "ask" is preserved; modes below handle it
      }
    }
    // tool "allow" / non-bypass "ask" falls through to mode checks
  }

  // Prefer any sanitized input the tool produced (e.g. resolved paths),
  // falling back to the raw input when checkPermissions was not defined
  // or returned a variant without updatedInput.
  const effectiveInput =
    (toolResult?.behavior === "allow" && toolResult.updatedInput)
      ? toolResult.updatedInput
      : input;

  // 3b. Interactive tool guard (bypass-immune)
  if (tool.requiresUserInteraction && permCtx.mode === "bypassPermissions") {
    return {
      behavior: "ask",
      message: `Tool "${toolName}" requires user interaction.`,
      reason: "interaction",
    };
  }

  // 4. Mode-based bypass / enforcement
  if (permCtx.mode === "bypassPermissions") {
    return {
      behavior: "allow",
      updatedInput: effectiveInput,
      reason: "mode",
    };
  }

  const isReadOnly = resolveToolFlag(tool.isReadOnly, input);
  const isDestructive = resolveToolFlag(tool.isDestructive, input);

  if (permCtx.mode === "plan" && !isReadOnly) {
    return {
      behavior: "deny",
      message: `Tool "${toolName}" is not allowed in plan mode (read-only).`,
      reason: "mode",
    };
  }

  if (permCtx.mode === "acceptEdits") {
    return resolveAcceptEditsDecision({
      toolName,
      input,
      effectiveInput,
      isReadOnly,
      isDestructive,
      workingDirectories: permCtx.workingDirectories,
    });
  }

  // Auto mode: use classifier to decide
  if (permCtx.mode === "auto" && opts?.autoModeConfig) {
    if (!opts.provider) {
      return {
        behavior: "ask",
        message: `Auto-mode requires an AI provider for classification. Falling back to ask.`,
        reason: "classifier",
      };
    }

    const classifierResult = await classifyPermission(
      toolName,
      input,
      opts.recentMessages ?? [],
      opts.provider,
      {
        classifierPrompt: opts.autoModeConfig.classifierPrompt,
        classifierModel: opts.autoModeConfig.classifierModel,
        model: opts.model,
        signal: opts.signal,
      },
    );

    return resolveAutoModeDecision({
      toolName,
      effectiveInput,
      classifierResult,
      denialTracker: opts.denialTracker,
      requiresUserInteraction: !!tool.requiresUserInteraction,
    });
  }

  // Tool's checkPermissions explicitly approved this call and no mode
  // (plan, acceptEdits, auto) overrode it — honor the tool's decision.
  if (toolResult?.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: effectiveInput,
      reason: toolResult.reason ?? "tool",
    };
  }

  // Read-only tools are auto-allowed in any mode (except when an ask/deny
  // rule explicitly overrode them in steps 1-2 above, or the tool's own
  // checkPermissions returned "ask").
  if (isReadOnly && toolResult?.behavior !== "ask") {
    return {
      behavior: "allow",
      updatedInput: effectiveInput,
      reason: "readOnly",
    };
  }

  // 4b. Working directory enforcement (before allow rules so they can't
  // bypass cwd restrictions — bypass-immune safety check).
  if (permCtx.workingDirectories.length > 0) {
    const filePath =
      typeof input.file_path === "string" ? input.file_path
      : typeof input.path === "string" ? input.path
      : undefined;
    if (filePath && !isPathInWorkingDirectories(filePath, permCtx.workingDirectories)) {
      return {
        behavior: "ask",
        message: `Path "${filePath}" is outside configured working directories.`,
        reason: "workingDirectory",
      };
    }
  }

  // 5. Content-specific allow rules
  if (contentHint !== undefined) {
    const contentAllowRules = getMatchingRules(
      permCtx,
      toolName,
      "allow",
      contentHint,
      tool.mcpInfo,
    );
    if (contentAllowRules.length > 0) {
      return {
        behavior: "allow",
        updatedInput: effectiveInput,
        reason: "rule",
      };
    }
  }

  // Whole-tool allow rules
  const wholeAllowRules = getMatchingRules(
    permCtx,
    toolName,
    "allow",
    undefined,
    tool.mcpInfo,
  );
  if (wholeAllowRules.length > 0) {
    return {
      behavior: "allow",
      updatedInput: effectiveInput,
      reason: "rule",
    };
  }

  // If tool raised ask and no mode overrode it, surface the tool's ask
  // (dontAsk is handled as a post-processing step below to also catch
  // passthrough→ask conversions)
  let finalAsk: PermissionDecision | undefined;
  if (toolResult?.behavior === "ask") {
    finalAsk = {
      behavior: "ask",
      message: toolResult.message,
      reason: toolResult.reason ?? "tool",
      suggestions: toolResult.suggestions,
    };
  }

  // 6. Fallback: passthrough → ask
  if (!finalAsk) {
    const message =
      toolResult?.behavior === "passthrough"
        ? toolResult.message
        : `Tool "${toolName}" requires approval.`;
    const suggestions =
      toolResult?.behavior === "passthrough"
        ? toolResult.suggestions
        : undefined;

    finalAsk = {
      behavior: "ask",
      message,
      reason: "default",
      suggestions,
    };
  }

  // dontAsk mode: deny anything that would prompt. Applied after all
  // ask/passthrough→ask paths so no ask result can leak through.
  if (permCtx.mode === "dontAsk") {
    return {
      behavior: "deny",
      message: `Tool "${toolName}" requires approval, but mode is "dontAsk".`,
      reason: "mode",
    };
  }

  return finalAsk;
}

// extractContentHint is now imported from ./helpers.js

/**
 * Check whether a file path targets a sensitive location that should always
 * prompt regardless of permission mode (bypass-immune safety check).
 *
 * Pass `dotDirNames` to override the protected dot-dir list (e.g. to
 * reflect a custom `DotDirConfig`). Defaults to `['.noumen', '.claude']`.
 */
export function isDangerousPath(
  filePath: string,
  basePath?: string,
  dotDirNames?: string[],
): boolean {
  const base = basePath ?? process.cwd();
  const resolved = path.resolve(base, filePath);
  const relative = path.relative(base, resolved);
  const candidate = (relative.startsWith("..") ? resolved.replace(/^\/+/, "") : relative).toLowerCase();
  const patterns = buildDangerousPathPatterns(dotDirNames);
  if (patterns.some((p) => p.test(candidate))) return true;

  // Also check symlink-resolved path to prevent symlink-based bypasses
  try {
    const realPath = fs.realpathSync(resolved);
    if (realPath !== resolved) {
      const realRelative = path.relative(base, realPath);
      const realCandidate = (realRelative.startsWith("..") ? realPath.replace(/^\/+/, "") : realRelative).toLowerCase();
      if (patterns.some((p) => p.test(realCandidate))) return true;
    }
  } catch {
    // Path doesn't exist yet — only the logical check applies
  }

  return false;
}
