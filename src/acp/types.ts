/**
 * ACP (Agent Client Protocol) types.
 *
 * ACP is a JSON-RPC 2.0 protocol (like LSP) for communication between
 * clients (editors, UIs) and AI coding agents over stdio or HTTP.
 */

// ── Capability negotiation ──────────────────────────────────────────────────

export interface AcpCapabilities {
  streaming?: boolean;
  permissions?: boolean;
  tools?: string[];
  sessions?: boolean;
}

export interface AcpInitializeParams {
  clientName: string;
  clientVersion: string;
  capabilities?: {
    filesystem?: boolean;
    terminal?: boolean;
  };
}

export interface AcpInitializeResult {
  agentName: string;
  agentVersion: string;
  protocolVersion: string;
  capabilities: AcpCapabilities;
}

// ── Session methods ─────────────────────────────────────────────────────────

export interface AcpSessionNewParams {
  sessionId?: string;
}

export interface AcpSessionNewResult {
  sessionId: string;
}

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: string;
}

export interface AcpSessionLoadParams {
  sessionId: string;
}

export interface AcpSessionLoadResult {
  sessionId: string;
  messageCount: number;
}

// ── Stream notifications (agent -> client) ──────────────────────────────────

export interface AcpStreamTextNotification {
  sessionId: string;
  text: string;
}

export interface AcpStreamToolUseNotification {
  sessionId: string;
  toolName: string;
  toolUseId: string;
  input?: string;
}

export interface AcpStreamCompleteNotification {
  sessionId: string;
  text: string | null;
}

export interface AcpStreamErrorNotification {
  sessionId: string;
  error: string;
}

// ── Client-invoked methods (agent -> client, for fs/terminal) ───────────────

export interface AcpFsReadParams {
  path: string;
}

export interface AcpFsReadResult {
  content: string;
}

export interface AcpFsBytesReadParams {
  path: string;
  maxBytes?: number;
}

export interface AcpFsBytesReadResult {
  /** Base64-encoded file content */
  data: string;
}

export interface AcpFsWriteParams {
  path: string;
  content: string;
}

export interface AcpFsStatParams {
  path: string;
}

export interface AcpFsStatResult {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt?: string;
}

export interface AcpTerminalExecParams {
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface AcpTerminalExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ── Permission bridge ───────────────────────────────────────────────────────

export interface AcpPermissionRequestNotification {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  message: string;
}

export interface AcpPermissionResponseParams {
  sessionId: string;
  allow: boolean;
  feedback?: string;
}

// ── Transport interface ─────────────────────────────────────────────────────

export interface AcpTransport {
  /** Send a JSON-RPC message to the peer. */
  send(message: unknown): void;
  /** Register a handler for incoming JSON-RPC messages. */
  onMessage(handler: (message: unknown) => void): void;
  /** Register a close handler. */
  onClose(handler: () => void): void;
  /** Close the transport. */
  close(): void;
}

// ── Method constants ────────────────────────────────────────────────────────

export const ACP_METHODS = {
  INITIALIZE: "initialize",
  SESSION_NEW: "session/new",
  SESSION_PROMPT: "session/prompt",
  SESSION_LOAD: "session/load",
  SESSION_ABORT: "session/abort",

  // Client-invoked
  FS_READ: "fs/read_text_file",
  FS_READ_BYTES: "fs/read_bytes",
  FS_WRITE: "fs/write_text_file",
  FS_STAT: "fs/stat",
  FS_EXISTS: "fs/exists",
  FS_READDIR: "fs/readdir",
  FS_MKDIR: "fs/mkdir",
  FS_DELETE: "fs/delete",
  TERMINAL_EXEC: "terminal/exec",

  // Notifications (agent -> client)
  STREAM_TEXT: "stream/text",
  STREAM_THINKING: "stream/thinking",
  STREAM_TOOL_USE: "stream/toolUse",
  STREAM_TOOL_RESULT: "stream/toolResult",
  STREAM_COMPLETE: "stream/complete",
  STREAM_ERROR: "stream/error",
  PERMISSION_REQUEST: "permission/request",
  PERMISSION_RESPONSE: "permission/response",
  USER_INPUT_REQUEST: "userInput/request",
  USER_INPUT_RESPONSE: "userInput/response",
} as const;
