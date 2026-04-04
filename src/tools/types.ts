import type { VirtualFs } from "../virtual/fs.js";
import type { VirtualComputer } from "../virtual/computer.js";
import type { PermissionResult } from "../permissions/types.js";
import type { PermissionMode } from "../permissions/types.js";
import type { TaskStore } from "../tasks/store.js";
import type { LspServerManager } from "../lsp/manager.js";
import type { FileCheckpointManager } from "../checkpoint/manager.js";
import type { FileStateCache } from "../file-state/cache.js";

export interface ToolResult {
  content: string | import("../session/types.js").ContentPart[];
  isError?: boolean;
  /** Opaque metadata bag for tool-specific information (e.g. git operations). */
  metadata?: Record<string, unknown>;
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
  /** The session ID of the current thread (used by Agent tool for hook events). */
  sessionId?: string;
  /** Hook definitions from the parent thread (used by Agent tool for subagent lifecycle hooks). */
  hooks?: import("../hooks/types.js").HookDefinition[];
  /** Factory for spawning isolated subagent threads. */
  spawnSubagent?: (config: SubagentConfig) => SubagentRun;
  /** Handler for user input requests from the AskUser tool. */
  userInputHandler?: (question: string) => Promise<string>;
  /** Task store for TaskCreate/List/Get/Update tools. */
  taskStore?: TaskStore;
  /** Set the current permission mode (used by PlanMode tools). */
  setPermissionMode?: (mode: PermissionMode) => void;
  /** Get the current permission mode. */
  getPermissionMode?: () => PermissionMode;
  /** Set the thread's working directory (used by Worktree tools). */
  setCwd?: (cwd: string) => void;
  /** LSP server manager for the LSP tool. */
  lspManager?: LspServerManager;
  /** File checkpoint manager for pre-edit backup tracking. */
  checkpointManager?: FileCheckpointManager;
  /** Current message ID for checkpoint tracking (set per user turn). */
  currentMessageId?: string;
  /** File state cache for read-before-edit enforcement and dedup. */
  fileStateCache?: FileStateCache;
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
  /**
   * Long model-facing instructions sent as the tool's API description.
   * When omitted, `description` is used instead. This allows a short
   * `description` for UI/permission prompts while sending detailed
   * usage guidance to the model.
   */
  prompt?: string | (() => string);
  parameters: ToolParameters;
  /**
   * Optional Zod schema for input validation. When present, tool input is
   * validated via `safeParse` before execution. Validation errors are returned
   * to the model as tool_result errors so it can self-correct.
   */
  inputSchema?: import("../utils/zod.js").ZodLikeSchema;
  /**
   * Raw JSON Schema for tool input — sent directly to providers that support
   * strict mode. When omitted, `parameters` is used as the JSON schema.
   */
  inputJSONSchema?: Record<string, unknown>;
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

  /**
   * When true, this tool always requires interactive user input and must
   * prompt even in bypassPermissions mode (e.g. AskUser).
   */
  requiresUserInteraction?: boolean;

  call(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
