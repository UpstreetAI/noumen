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

  // 2b. Working directory enforcement for file paths
  if (permCtx.workingDirectories.length > 0) {
    const filePath =
      typeof input.file_path === "string" ? input.file_path
      : typeof input.path === "string" ? input.path
      : undefined;
    if (filePath && !isPathInWorkingDirectories(filePath, permCtx.workingDirectories)) {
      return {
        behavior: "deny",
        message: `Path "${filePath}" is outside configured working directories.`,
        reason: "workingDirectory",
      };
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
      throw err;
    }

    if (toolResult.behavior === "deny") {
      return {
        behavior: "deny",
        message: toolResult.message,
        reason: toolResult.reason ?? "tool",
      };
    }
    if (toolResult.behavior === "ask") {
      const isSafetyCheck = toolResult.reason === "safetyCheck";
      const isInteractive = tool.requiresUserInteraction === true;
      const isContentSpecificRule = toolResult.reason === "rule";

      if (isSafetyCheck || isInteractive || isContentSpecificRule || permCtx.mode !== "bypassPermissions") {
        return {
          behavior: "ask",
          message: toolResult.message,
          reason: toolResult.reason ?? "tool",
          suggestions: toolResult.suggestions,
        };
      }
    }
    if (toolResult.behavior === "allow") {
      return {
        behavior: "allow",
        updatedInput: toolResult.updatedInput,
        reason: toolResult.reason ?? "tool",
      };
    }
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
      return {
        behavior: "ask",
        message: `Auto-mode classifier flagged this call: ${result.reason}`,
        reason: "classifier",
      };
    }

    return {
      behavior: "allow",
      updatedInput: effectiveInput,
      reason: "classifier",
    };
  }

  // Read-only tools are auto-allowed in any mode (except when an ask/deny
  // rule explicitly overrode them in steps 1-2 above).
  if (isReadOnly) {
    return {
      behavior: "allow",
      updatedInput: effectiveInput,
      reason: "readOnly",
    };
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
