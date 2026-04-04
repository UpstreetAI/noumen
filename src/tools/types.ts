import type { VirtualFs } from "../virtual/fs.js";
import type { VirtualComputer } from "../virtual/computer.js";
import type { PermissionResult } from "../permissions/types.js";
import type { PermissionMode } from "../permissions/types.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface SubagentConfig {
  prompt: string;
  systemPrompt?: string;
  /** Tool name allowlist. When set, only these tools are available. */
  allowedTools?: string[];
  permissionMode?: PermissionMode;
  maxTurns?: number;
  model?: string;
}

/** Async generator of stream events from a subagent run. */
export interface SubagentRun {
  sessionId: string;
  events: AsyncGenerator<import("../session/types.js").StreamEvent, void, unknown>;
}

/**
 * Execution context passed to every tool call. All file and shell access
 * goes through `fs` and `computer`, which are the sandboxing boundary —
 * tools never touch `node:fs` or `child_process` directly. The isolation
 * level is determined by which VirtualFs/VirtualComputer implementations
 * the consumer provides (e.g. `LocalFs` for local dev, `SpritesFs` for
 * remote sandboxed containers).
 */
export interface ToolContext {
  fs: VirtualFs;
  computer: VirtualComputer;
  cwd: string;
  /** Factory for spawning isolated subagent threads. */
  spawnSubagent?: (config: SubagentConfig) => SubagentRun;
  /** Handler for user input requests from the AskUser tool. */
  userInputHandler?: (question: string) => Promise<string>;
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  /** Present on tools sourced from an MCP server */
  mcpInfo?: { serverName: string; toolName: string };

  /**
   * Whether this tool only reads state and never mutates it.
   * When `true`, the tool is auto-allowed in `default` mode for working directories
   * and is permitted in `plan` mode. Can be a static boolean or a function of the input.
   * Defaults to `false` when omitted.
   */
  isReadOnly?: boolean | ((args: Record<string, unknown>) => boolean);

  /**
   * Whether this tool performs irreversible/destructive operations.
   * Used as metadata in permission requests so handlers can make informed decisions.
   * Defaults to `false` when omitted.
   */
  isDestructive?: boolean | ((args: Record<string, unknown>) => boolean);

  /**
   * Whether this tool can safely run concurrently with other concurrency-safe
   * tools. Read-only tools are typically safe; tools that mutate shared state
   * (filesystem writes, shell commands) are not. Can be a static boolean or a
   * function of the input. Defaults to `false` when omitted.
   */
  isConcurrencySafe?: boolean | ((args: Record<string, unknown>) => boolean);

  /**
   * Tool-specific permission check, called by the permission pipeline before
   * global rules and mode-based decisions. Return `passthrough` to delegate
   * to the global pipeline, or `allow`/`deny`/`ask` for tool-specific logic.
   */
  checkPermissions?: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<PermissionResult> | PermissionResult;

  call(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
