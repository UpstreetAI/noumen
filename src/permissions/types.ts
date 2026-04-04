import type { ToolContext } from "../tools/types.js";

// --- Permission modes ---

export type PermissionMode =
  | "default"
  | "plan"
  | "bypassPermissions"
  | "dontAsk";

// --- Rule behavior ---

export type PermissionBehavior = "allow" | "deny" | "ask";

// --- Rules ---

export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
  behavior: PermissionBehavior;
}

// --- Decision result types ---

export interface PermissionAllowResult<
  Input extends Record<string, unknown> = Record<string, unknown>,
> {
  behavior: "allow";
  updatedInput?: Input;
  reason?: string;
}

export interface PermissionDenyResult {
  behavior: "deny";
  message: string;
  reason?: string;
}

export interface PermissionAskResult {
  behavior: "ask";
  message: string;
  reason?: string;
  suggestions?: PermissionRule[];
}

export interface PermissionPassthroughResult {
  behavior: "passthrough";
  message: string;
  reason?: string;
  suggestions?: PermissionRule[];
}

/**
 * What `Tool.checkPermissions` returns. Includes `passthrough` for tools that
 * have no opinion and want the global pipeline to decide.
 */
export type PermissionResult<
  Input extends Record<string, unknown> = Record<string, unknown>,
> =
  | PermissionAllowResult<Input>
  | PermissionDenyResult
  | PermissionAskResult
  | PermissionPassthroughResult;

/**
 * Final decision after the pipeline resolves. No `passthrough` — always
 * one of allow / deny / ask.
 */
export type PermissionDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> =
  | PermissionAllowResult<Input>
  | PermissionDenyResult
  | PermissionAskResult;

// --- Handler callback types ---

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  message: string;
  suggestions?: PermissionRule[];
  isReadOnly: boolean;
  isDestructive: boolean;
}

export interface PermissionResponse {
  allow: boolean;
  updatedInput?: Record<string, unknown>;
  feedback?: string;
  addRules?: PermissionRule[];
}

export type PermissionHandler = (
  request: PermissionRequest,
) => Promise<PermissionResponse>;

// --- Configuration ---

export interface PermissionConfig {
  mode?: PermissionMode;
  rules?: PermissionRule[];
  handler?: PermissionHandler;
  workingDirectories?: string[];
}

export interface PermissionContext {
  mode: PermissionMode;
  rules: PermissionRule[];
  workingDirectories: string[];
}

// --- Tool permission extension ---

/**
 * Optional permission metadata a `Tool` can provide.
 * Kept as a separate interface so it can be imported without circular deps.
 */
export interface ToolPermissionMethods {
  isReadOnly?: boolean | ((args: Record<string, unknown>) => boolean);
  isDestructive?: boolean | ((args: Record<string, unknown>) => boolean);
  checkPermissions?: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<PermissionResult> | PermissionResult;
}
