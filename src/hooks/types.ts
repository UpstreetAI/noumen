export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreCompact"
  | "PostCompact"
  | "TurnStart"
  | "TurnEnd"
  | "SubagentStart"
  | "SubagentStop"
  | "SessionStart"
  | "SessionEnd"
  | "PermissionRequest"
  | "PermissionDenied"
  | "FileWrite"
  | "ModelSwitch"
  | "RetryAttempt"
  | "MemoryUpdate"
  | "Error";

// ---------------------------------------------------------------------------
// Tool interceptor hooks
// ---------------------------------------------------------------------------

export interface PreToolUseHookInput {
  event: "PreToolUse";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
}

export interface PreToolUseHookOutput {
  decision?: "allow" | "deny" | "passthrough";
  updatedInput?: Record<string, unknown>;
  message?: string;
  preventContinuation?: boolean;
}

export interface PostToolUseHookInput {
  event: "PostToolUse";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  toolOutput: string;
  isError: boolean;
  sessionId: string;
}

export interface PostToolUseHookOutput {
  updatedOutput?: string;
  preventContinuation?: boolean;
}

export interface PostToolUseFailureHookInput {
  event: "PostToolUseFailure";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  toolOutput: string;
  errorMessage: string;
  sessionId: string;
}

export type PostToolUseFailureHookOutput = PostToolUseHookOutput;

// ---------------------------------------------------------------------------
// Subagent hooks
// ---------------------------------------------------------------------------

export interface SubagentStartHookInput {
  event: "SubagentStart";
  sessionId: string;
  parentSessionId: string;
  prompt: string;
}

export interface SubagentStopHookInput {
  event: "SubagentStop";
  sessionId: string;
  parentSessionId: string;
  result: string;
}

// ---------------------------------------------------------------------------
// Session lifecycle hooks
// ---------------------------------------------------------------------------

export interface SessionStartHookInput {
  event: "SessionStart";
  sessionId: string;
  prompt: string | unknown[];
  isResume: boolean;
}

export interface SessionEndHookInput {
  event: "SessionEnd";
  sessionId: string;
  reason: "complete" | "abort" | "maxTurns" | "error";
}

// ---------------------------------------------------------------------------
// Permission hooks
// ---------------------------------------------------------------------------

export interface PermissionRequestHookInput {
  event: "PermissionRequest";
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  mode: string;
}

export interface PermissionDeniedHookInput {
  event: "PermissionDenied";
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
}

// ---------------------------------------------------------------------------
// File hooks
// ---------------------------------------------------------------------------

export interface FileWriteHookInput {
  event: "FileWrite";
  sessionId: string;
  toolName: string;
  filePath: string;
  isNew: boolean;
}

// ---------------------------------------------------------------------------
// Model hooks
// ---------------------------------------------------------------------------

export interface ModelSwitchHookInput {
  event: "ModelSwitch";
  sessionId: string;
  previousModel: string | undefined;
  newModel: string;
}

// ---------------------------------------------------------------------------
// Retry hooks
// ---------------------------------------------------------------------------

export interface RetryAttemptHookInput {
  event: "RetryAttempt";
  sessionId: string;
  attempt: number;
  maxAttempts: number;
  error: string;
  delay: number;
}

// ---------------------------------------------------------------------------
// Memory hooks
// ---------------------------------------------------------------------------

export interface MemoryUpdateHookInput {
  event: "MemoryUpdate";
  sessionId: string;
  entries: Array<{ type: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Generic notification input (for TurnStart, TurnEnd, Error, PreCompact, PostCompact)
// ---------------------------------------------------------------------------

export interface NotificationHookInput {
  event:
    | "TurnStart"
    | "TurnEnd"
    | "Error"
    | "PreCompact"
    | "PostCompact";
  sessionId: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | PermissionRequestHookInput
  | PermissionDeniedHookInput
  | FileWriteHookInput
  | ModelSwitchHookInput
  | RetryAttemptHookInput
  | MemoryUpdateHookInput
  | NotificationHookInput;

export type HookOutput =
  | PreToolUseHookOutput
  | PostToolUseHookOutput
  | PostToolUseFailureHookOutput
  | void;

export interface HookDefinition {
  event: HookEvent;
  /** Optional tool name glob filter (e.g. "Bash", "mcp__*") */
  matcher?: string;
  /**
   * When true, errors thrown by this hook propagate as denials instead of
   * being silently swallowed. Use for security-critical hooks.
   */
  blocking?: boolean;
  handler: (input: HookInput) => Promise<HookOutput> | HookOutput;
}
