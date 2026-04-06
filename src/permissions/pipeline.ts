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
import { extractCommandName, splitCompoundCommand } from "../tools/shell-safety/command-classification.js";

const ACCEPT_EDITS_BASH_ALLOWLIST = new Set([
  "mkdir", "touch", "mv", "cp", "sed", "chmod",
]);

const DANGEROUS_PATH_PATTERNS = [
  /(?:^|\/)\.git\//,
  /(?:^|\/)\.bashrc$/,
  /(?:^|\/)\.bash_profile$/,
  /(?:^|\/)\.zshrc$/,
  /(?:^|\/)\.zprofile$/,
  /(?:^|\/)\.profile$/,
  /(?:^|\/)\.ssh\//,
  /(?:^|\/)\.env$/,
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.vscode\//,
  /(?:^|\/)\.idea\//,
  /(?:^|\/)\.claude\//,
  /(?:^|\/)\.noumen\//,
  /(?:^|\/)\.gitconfig$/,
  /(?:^|\/)\.gitmodules$/,
  /(?:^|\/)\.mcp\.json$/,
  /(?:^|\/)\.ripgreprc$/,
  /(?:^|\/)\.noumen\.json$/,
];

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
  if (dangerousFilePath && isDangerousPath(dangerousFilePath, ctx.cwd)) {
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
        if (isDangerousPath(token, ctx.cwd)) {
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
    if (isDestructive) {
      return {
        behavior: "ask",
        message: `Tool "${toolName}" is destructive and requires approval in acceptEdits mode.`,
        reason: "mode",
      };
    }
    if (toolName === "Bash") {
      const cmd = typeof input.command === "string" ? input.command : "";
      const subCommands = splitCompoundCommand(cmd);
      for (const sub of subCommands) {
        const baseName = extractCommandName(sub);
        if (!ACCEPT_EDITS_BASH_ALLOWLIST.has(baseName)) {
          return {
            behavior: "ask",
            message: `Tool "${toolName}" (${baseName}) is not in the acceptEdits allowlist.`,
            reason: "mode",
          };
        }
      }
    }
    if (permCtx.workingDirectories.length > 0) {
      const filePath =
        typeof input.file_path === "string" ? input.file_path
        : typeof input.path === "string" ? input.path
        : undefined;
      if (filePath && !isPathInWorkingDirectories(filePath, permCtx.workingDirectories)) {
        return {
          behavior: "ask",
          message: `Path "${filePath}" is outside working directories in acceptEdits mode.`,
          reason: "workingDirectory",
        };
      }
    }
    // Non-file, non-bash, non-read-only tools require approval in acceptEdits
    const hasFilePath = typeof input.file_path === "string" || typeof input.path === "string";
    if (!isReadOnly && !hasFilePath && toolName !== "Bash") {
      return {
        behavior: "ask",
        message: `Tool "${toolName}" requires approval in acceptEdits mode.`,
        reason: "mode",
      };
    }
    return {
      behavior: "allow",
      updatedInput: effectiveInput,
      reason: "mode",
    };
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

    const result = await classifyPermission(
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

    if (result.shouldBlock) {
      if (opts.denialTracker) {
        opts.denialTracker.recordDenial();
        const fallback = opts.denialTracker.shouldFallback();
        if (fallback.triggered) {
          opts.denialTracker.resetAfterFallback(fallback.reason);
          return {
            behavior: "ask",
            message: `Auto-mode classifier denied too many consecutive actions. Falling back to user prompt.`,
            reason: "denial_limit",
          };
        }
      }
      return {
        behavior: "deny",
        message: `Auto-mode classifier flagged this call: ${result.reason}`,
        reason: "classifier",
      };
    }

    if (tool.requiresUserInteraction) {
      return {
        behavior: "ask",
        message: `Tool "${toolName}" requires user interaction.`,
        reason: "interaction",
      };
    }

    opts?.denialTracker?.recordSuccess();

    return {
      behavior: "allow",
      updatedInput: effectiveInput,
      reason: "classifier",
    };
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

  // dontAsk mode: deny anything that would prompt (reads already allowed above)
  if (permCtx.mode === "dontAsk") {
    return {
      behavior: "deny",
      message: `Tool "${toolName}" requires approval, but mode is "dontAsk".`,
      reason: "mode",
    };
  }

  // If tool raised ask and no mode overrode it, surface the tool's ask
  if (toolResult?.behavior === "ask") {
    return {
      behavior: "ask",
      message: toolResult.message,
      reason: toolResult.reason ?? "tool",
      suggestions: toolResult.suggestions,
    };
  }

  // 6. Fallback: passthrough → ask
  const message =
    toolResult?.behavior === "passthrough"
      ? toolResult.message
      : `Tool "${toolName}" requires approval.`;
  const suggestions =
    toolResult?.behavior === "passthrough"
      ? toolResult.suggestions
      : undefined;

  return {
    behavior: "ask",
    message,
    reason: "default",
    suggestions,
  };
}

/**
 * Extract a content string from tool input for rule matching.
 *
 * For file tools this is the `file_path`; for bash it's the `command`.
 * Returns `undefined` if no meaningful content is available.
 */
function extractContentHint(
  tool: Tool,
  input: Record<string, unknown>,
): string | undefined {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command;
  if (typeof input.path === "string") return input.path;
  return undefined;
}

/**
 * Check whether a file path targets a sensitive location that should always
 * prompt regardless of permission mode (bypass-immune safety check).
 */
export function isDangerousPath(filePath: string, basePath?: string): boolean {
  const base = basePath ?? process.cwd();
  const resolved = path.resolve(base, filePath);
  const relative = path.relative(base, resolved);
  const candidate = (relative.startsWith("..") ? resolved.replace(/^\/+/, "") : relative).toLowerCase();
  if (DANGEROUS_PATH_PATTERNS.some((p) => p.test(candidate))) return true;

  // Also check symlink-resolved path to prevent symlink-based bypasses
  try {
    const realPath = fs.realpathSync(resolved);
    if (realPath !== resolved) {
      const realRelative = path.relative(base, realPath);
      const realCandidate = (realRelative.startsWith("..") ? realPath.replace(/^\/+/, "") : realRelative).toLowerCase();
      if (DANGEROUS_PATH_PATTERNS.some((p) => p.test(realCandidate))) return true;
    }
  } catch {
    // Path doesn't exist yet — only the logical check applies
  }

  return false;
}
