export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "PostCompact"
  | "TurnStart"
  | "TurnEnd"
  | "SubagentStart"
  | "SubagentStop"
  | "Error";

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

export interface NotificationHookInput {
  event: "TurnStart" | "TurnEnd" | "Error" | "PreCompact" | "PostCompact";
  sessionId: string;
  [key: string]: unknown;
}

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | NotificationHookInput;

export type HookOutput =
  | PreToolUseHookOutput
  | PostToolUseHookOutput
  | void;

export interface HookDefinition {
  event: HookEvent;
  /** Optional tool name glob filter (e.g. "Bash", "mcp__*") */
  matcher?: string;
  handler: (input: HookInput) => Promise<HookOutput> | HookOutput;
}
