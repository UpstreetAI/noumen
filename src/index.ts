// Main API
export { Code, type CodeOptions } from "./code.js";
export { Thread, type ThreadOptions, type ThreadConfig } from "./thread.js";

// AI Providers
export type {
  AIProvider,
  ChatParams,
  ChatStreamChunk,
  ChatStreamChoice,
  ChatStreamDelta,
  ToolDefinition,
  ToolParameterProperty as ToolDefParameterProperty,
  ChatCompletionUsage,
} from "./providers/types.js";
export {
  OpenAIProvider,
  type OpenAIProviderOptions,
} from "./providers/openai.js";
export {
  AnthropicProvider,
  type AnthropicProviderOptions,
} from "./providers/anthropic.js";
export {
  GeminiProvider,
  type GeminiProviderOptions,
} from "./providers/gemini.js";

// Virtual infrastructure (sandboxing primitives)
// VirtualFs and VirtualComputer are the isolation boundary — all tool I/O
// routes through them. Swap implementations to control the sandbox level.
export type {
  VirtualFs,
  FileEntry,
  FileStat,
  ReadOptions,
} from "./virtual/fs.js";
export type {
  VirtualComputer,
  ExecOptions,
  CommandResult,
} from "./virtual/computer.js";
export { LocalFs, type LocalFsOptions } from "./virtual/local-fs.js";
export {
  LocalComputer,
  type LocalComputerOptions,
} from "./virtual/local-computer.js";
export { SpritesFs, type SpritesFsOptions } from "./virtual/sprites-fs.js";
export {
  SpritesComputer,
  type SpritesComputerOptions,
} from "./virtual/sprites-computer.js";

// Session types
export type {
  ChatMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  SystemMessage,
  ToolCallContent,
  SerializedMessage,
  Entry,
  MessageEntry,
  CompactBoundaryEntry,
  SummaryEntry,
  CustomTitleEntry,
  MetadataEntry,
  SessionInfo,
  StreamEvent,
  ToolResult,
  RunOptions,
} from "./session/types.js";

// Tools
export type {
  Tool,
  ToolContext,
  ToolParameters,
  ToolResult as ToolCallResult,
  SubagentConfig,
  SubagentRun,
} from "./tools/types.js";
export { ToolRegistry } from "./tools/registry.js";
export { readFileTool } from "./tools/read.js";
export { writeFileTool } from "./tools/write.js";
export { editFileTool } from "./tools/edit.js";
export { bashTool } from "./tools/bash.js";
export { globTool } from "./tools/glob.js";
export { grepTool } from "./tools/grep.js";
export { createSkillTool } from "./tools/skill.js";
export { agentTool } from "./tools/agent.js";
export { webFetchTool } from "./tools/web-fetch.js";
export {
  createWebSearchTool,
  webSearchToolPlaceholder,
  type WebSearchResult,
  type WebSearchConfig,
} from "./tools/web-search.js";
export { notebookEditTool } from "./tools/notebook.js";
export { askUserTool, type UserInputHandler } from "./tools/ask-user.js";
export {
  runToolsBatched,
  partitionToolCalls,
  type ToolCallExecResult,
  type ToolCallExecutor,
} from "./tools/orchestration.js";

export {
  StreamingToolExecutor,
  type StreamingExecResult,
  type StreamingToolExecutorFn,
} from "./tools/streaming-executor.js";

// Utilities
export { all } from "./utils/generators.js";

// Skills
export type { SkillDefinition } from "./skills/types.js";
export { loadSkills } from "./skills/loader.js";
export { parseFrontmatter, parseAllowedTools, parsePaths } from "./skills/frontmatter.js";
export type { FrontmatterData, ParsedFrontmatter } from "./skills/frontmatter.js";
export { activateSkillsForPaths, getActiveSkills } from "./skills/activation.js";

// MCP
export { McpClientManager } from "./mcp/client.js";
export type {
  McpServerConfig,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpConfig,
  McpConnection,
  McpToolInfo,
} from "./mcp/types.js";
export { createMcpServer, type McpServerOptions } from "./mcp/server.js";
export {
  normalizeNameForMCP,
  buildMcpToolName,
  getMcpPrefix,
  parseMcpToolName,
} from "./mcp/normalization.js";

// Compaction
export { compactConversation } from "./compact/compact.js";
export {
  createAutoCompactConfig,
  shouldAutoCompact,
  type AutoCompactConfig,
} from "./compact/auto-compact.js";

// System prompt
export { buildSystemPrompt } from "./prompt/system.js";

// Permissions
export type {
  PermissionMode,
  PermissionBehavior,
  PermissionRule,
  PermissionAllowResult,
  PermissionDenyResult,
  PermissionAskResult,
  PermissionPassthroughResult,
  PermissionResult,
  PermissionDecision,
  PermissionRequest,
  PermissionResponse,
  PermissionHandler,
  PermissionConfig,
  PermissionContext,
} from "./permissions/types.js";
export {
  toolMatchesRule,
  contentMatchesRule,
  matchSimpleGlob,
  getMatchingRules,
  isPathInWorkingDirectories,
} from "./permissions/rules.js";
export { resolvePermission } from "./permissions/pipeline.js";
export { resolveToolFlag } from "./tools/registry.js";

// Hooks
export type {
  HookEvent,
  HookDefinition,
  HookInput,
  HookOutput,
  PreToolUseHookInput,
  PreToolUseHookOutput,
  PostToolUseHookInput,
  PostToolUseHookOutput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  NotificationHookInput,
} from "./hooks/types.js";
export {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runNotificationHooks,
} from "./hooks/runner.js";
