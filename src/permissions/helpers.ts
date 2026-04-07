import * as path from "node:path";
import type { PermissionDecision, PermissionContext } from "./types.js";
import type { DenialTracker } from "./denial-tracking.js";
import type { ClassifierResult } from "./classifier.js";
import type { Tool } from "../tools/types.js";
import { isPathInWorkingDirectories } from "./rules.js";
import { extractCommandName, splitCompoundCommand } from "../tools/shell-safety/command-classification.js";

const ACCEPT_EDITS_BASH_ALLOWLIST = new Set([
  "mkdir", "touch", "mv", "cp", "sed", "chmod",
]);

// ---------------------------------------------------------------------------
// extractContentHint
// ---------------------------------------------------------------------------

export function extractContentHint(
  tool: Tool,
  input: Record<string, unknown>,
): string | undefined {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command;
  if (typeof input.path === "string") return input.path;
  return undefined;
}

// ---------------------------------------------------------------------------
// resolveAcceptEditsDecision
// ---------------------------------------------------------------------------

export interface AcceptEditsInput {
  toolName: string;
  input: Record<string, unknown>;
  effectiveInput: Record<string, unknown>;
  isReadOnly: boolean;
  isDestructive: boolean;
  workingDirectories: string[];
}

export function resolveAcceptEditsDecision(
  params: AcceptEditsInput,
): PermissionDecision {
  const { toolName, input, effectiveInput, isReadOnly, isDestructive, workingDirectories } = params;

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
    if (workingDirectories.length > 0) {
      for (const sub of subCommands) {
        const tokens = sub.trim().split(/\s+/).slice(1);
        for (const token of tokens) {
          if (token.startsWith("-")) continue;
          if (path.isAbsolute(token) && !isPathInWorkingDirectories(token, workingDirectories)) {
            return {
              behavior: "ask",
              message: `Bash command references path "${token}" outside working directories.`,
              reason: "workingDirectory",
            };
          }
        }
      }
    }
  }

  if (workingDirectories.length > 0) {
    const filePath =
      typeof input.file_path === "string" ? input.file_path
      : typeof input.path === "string" ? input.path
      : undefined;
    if (filePath && !isPathInWorkingDirectories(filePath, workingDirectories)) {
      return {
        behavior: "ask",
        message: `Path "${filePath}" is outside working directories in acceptEdits mode.`,
        reason: "workingDirectory",
      };
    }
  }

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

// ---------------------------------------------------------------------------
// resolveAutoModeDecision
// ---------------------------------------------------------------------------

export interface AutoModeInput {
  toolName: string;
  effectiveInput: Record<string, unknown>;
  classifierResult: ClassifierResult;
  denialTracker?: DenialTracker;
  requiresUserInteraction: boolean;
}

export function resolveAutoModeDecision(
  params: AutoModeInput,
): PermissionDecision {
  const { toolName, effectiveInput, classifierResult, denialTracker, requiresUserInteraction } = params;

  if (classifierResult.shouldBlock) {
    if (denialTracker) {
      denialTracker.recordDenial();
      const fallback = denialTracker.shouldFallback();
      if (fallback.triggered) {
        if (fallback.reason === "repeated_consecutive") {
          return {
            behavior: "deny",
            message: `Auto-mode classifier denied too many actions without user approval. Aborting.`,
            reason: "denial_limit",
          };
        }
        denialTracker.resetAfterFallback(fallback.reason as "consecutive" | "total");
        return {
          behavior: "ask",
          message: `Auto-mode classifier denied too many consecutive actions. Falling back to user prompt.`,
          reason: "denial_limit",
        };
      }
    }
    return {
      behavior: "deny",
      message: `Auto-mode classifier flagged this call: ${classifierResult.reason}`,
      reason: "classifier",
    };
  }

  if (requiresUserInteraction) {
    return {
      behavior: "ask",
      message: `Tool "${toolName}" requires user interaction.`,
      reason: "interaction",
    };
  }

  denialTracker?.recordSuccess();

  return {
    behavior: "allow",
    updatedInput: effectiveInput,
    reason: "classifier",
  };
}
