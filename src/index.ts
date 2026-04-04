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
  OutputFormat,
} from "./providers/types.js";
export { ChatStreamError } from "./providers/types.js";
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
export {
  OpenRouterProvider,
  type OpenRouterProviderOptions,
} from "./providers/openrouter.js";

// Sandbox (bundled VirtualFs + VirtualComputer)
export {
  LocalSandbox,
  SpritesSandbox,
  type Sandbox,
  type LocalSandboxOptions,
  type SpritesSandboxOptions,
} from "./virtual/sandbox.js";

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

// File State Cache
export type { FileState, FileStateCacheConfig } from "./file-state/types.js";
export { FileStateCache } from "./file-state/cache.js";

// Session types
export type {
  ChatMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  SystemMessage,
  TextContent,
  ImageContent,
  ImageUrlContent,
  ContentPart,
  ToolCallContent,
  SerializedMessage,
  Entry,
  MessageEntry,
  CompactBoundaryEntry,
  SummaryEntry,
  ToolResultOverflowEntry,
  CustomTitleEntry,
  MetadataEntry,
  SessionInfo,
  StreamEvent,
  ToolResult,
  RunOptions,
  ContentReplacementEntry,
  ContentReplacementRecord,
  SnipBoundaryEntry,
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
export {
  normalizeQuotes,
  findActualString,
  countOccurrences,
  preserveQuoteStyle,
  stripTrailingWhitespace,
} from "./tools/edit-utils.js";
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
  createToolSearchTool,
  isDeferredTool,
  formatDeferredToolLine,
  searchToolsWithKeywords,
  TOOL_SEARCH_NAME,
  type ToolWithDeferral,
} from "./tools/tool-search.js";
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

// Shell safety / command classification
export { classifyCommand } from "./tools/shell-safety/command-classification.js";
export type {
  CommandClassification,
  ShellSafetyConfig,
} from "./tools/shell-safety/types.js";

// Task management
export type { Task, TaskStatus, TaskCreateInput, TaskUpdateInput } from "./tasks/types.js";
export { TaskStore } from "./tasks/store.js";
export { taskCreateTool } from "./tools/task-create.js";
export { taskListTool } from "./tools/task-list.js";
export { taskGetTool } from "./tools/task-get.js";
export { taskUpdateTool } from "./tools/task-update.js";

// Plan mode + Worktree tools
export { enterPlanModeTool, exitPlanModeTool } from "./tools/plan-mode.js";
export { enterWorktreeTool, exitWorktreeTool } from "./tools/worktree.js";
export {
  findGitRoot,
  createWorktree,
  removeWorktree,
  listWorktrees,
  getWorktreeChanges,
  sanitizeWorktreeSlug,
} from "./utils/worktree.js";
export type { WorktreeInfo } from "./utils/worktree.js";

// LSP integration
export type {
  LspServerConfig,
  LspServerState,
  LspDiagnostic,
  LspOperation,
  LspLocation,
  LspSymbol,
} from "./lsp/types.js";
export { LspClient } from "./lsp/client.js";
export { LspServerManager } from "./lsp/manager.js";
export { DiagnosticRegistry } from "./lsp/diagnostics.js";
export { lspTool } from "./tools/lsp.js";

// Multi-agent swarm
export type {
  SwarmConfig,
  SwarmMember,
  SwarmMemberConfig,
  SwarmMemberStatus,
  SwarmMessage,
  SwarmStatus,
  SwarmEvents,
} from "./swarm/types.js";
export { SwarmManager } from "./swarm/manager.js";
export { Mailbox } from "./swarm/mailbox.js";
export type { SwarmBackend } from "./swarm/backends/types.js";
export { InProcessBackend } from "./swarm/backends/in-process.js";

// Content utilities (multimodal helpers)
export {
  normalizeContent,
  contentToString,
  hasImageContent,
  stripImageContent,
} from "./utils/content.js";

// Utilities
export { all } from "./utils/generators.js";
export {
  zodToJsonSchema,
  registerZodToJsonSchema,
  formatZodValidationError,
} from "./utils/zod.js";
export type {
  ZodLikeSchema,
  SafeParseResult,
  JsonSchemaType,
} from "./utils/zod.js";

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
export { compactConversation, estimateCompactionSavings } from "./compact/compact.js";
export type { CompactOptions } from "./compact/compact.js";
export {
  createAutoCompactConfig,
  shouldAutoCompact,
  canAutoCompact,
  recordAutoCompactSuccess,
  recordAutoCompactFailure,
  createAutoCompactTracking,
  type AutoCompactConfig,
  type AutoCompactTrackingState,
} from "./compact/auto-compact.js";

// Microcompact
export {
  microcompactMessages,
  COMPACTABLE_TOOLS,
  CLEARED_PLACEHOLDER,
} from "./compact/microcompact.js";
export type { MicrocompactConfig, MicrocompactResult } from "./compact/microcompact.js";

// Tool result storage (disk-backed spilling)
export {
  persistToolResult,
  enforceToolResultStorageBudget,
  reconstructContentReplacementState,
  applyPersistedReplacements,
  createContentReplacementState,
} from "./compact/tool-result-storage.js";
export type {
  ToolResultStorageConfig,
  ContentReplacementState,
  ContentReplacementRecord as ToolResultReplacementRecord,
  ToolResultSpillResult,
} from "./compact/tool-result-storage.js";

// Tool result budget
export {
  enforceToolResultBudget,
  createBudgetState,
} from "./compact/tool-result-budget.js";
export type {
  ToolResultBudgetConfig,
  BudgetState,
  ToolResultBudgetResult,
} from "./compact/tool-result-budget.js";

// History snip
export {
  applySnipRemovals,
  snipMessagesByUuids,
  projectSnippedView,
} from "./compact/history-snip.js";
export type {
  SnipConfig,
  SnipResult,
} from "./compact/history-snip.js";

// Reactive compact
export { tryReactiveCompact } from "./compact/reactive-compact.js";
export type { ReactiveCompactConfig, ReactiveCompactResult } from "./compact/reactive-compact.js";

// Context window / token utilities
export {
  getContextWindowForModel,
  getEffectiveContextWindow,
  getAutoCompactThreshold,
  registerContextWindows,
} from "./utils/context.js";
export {
  estimateTokens,
  estimateMessagesTokens,
  tokenCountWithEstimation,
  truncateHeadForPTLRetry,
  groupMessagesByTurn,
} from "./utils/tokens.js";

// System prompt
export { buildSystemPrompt } from "./prompt/system.js";

// Permissions
export type {
  PermissionMode,
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
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
  PermissionUpdate,
  AutoModeConfig,
  DenialTrackingConfig,
} from "./permissions/types.js";
export { RULE_SOURCE_PRECEDENCE } from "./permissions/types.js";
export {
  toolMatchesRule,
  contentMatchesRule,
  matchSimpleGlob,
  getMatchingRules,
  isPathInWorkingDirectories,
} from "./permissions/rules.js";
export { resolvePermission } from "./permissions/pipeline.js";
export type { ResolvePermissionOptions } from "./permissions/pipeline.js";
export { resolveToolFlag } from "./tools/registry.js";
export { applyPermissionUpdate, applyPermissionUpdates } from "./permissions/updates.js";
export { DenialTracker } from "./permissions/denial-tracking.js";
export type { DenialLimits, DenialState } from "./permissions/denial-tracking.js";
export { classifyPermission } from "./permissions/classifier.js";
export type { ClassifierResult } from "./permissions/classifier.js";

// Thinking
export type { ThinkingConfig } from "./thinking/index.js";

// Cost tracking
export type {
  ModelPricing,
  UsageRecord,
  ModelUsageSummary,
  CostSummary,
} from "./cost/index.js";
export { CostTracker, calculateCost, findModelPricing, DEFAULT_PRICING } from "./cost/index.js";

// Retry / error resilience
export type {
  RetryConfig,
  RetryEngineOptions,
  RetryContext,
  RetryEvent,
} from "./retry/index.js";
export type { ClassifiedError } from "./retry/index.js";
export {
  DEFAULT_RETRY_CONFIG,
  classifyError,
  isRetryable,
  getRetryDelay,
  withRetry,
  CannotRetryError,
  FallbackTriggeredError,
} from "./retry/index.js";

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

// Tracing / Observability
export {
  SpanStatusCode,
  type Span,
  type SpanAttributeValue,
  type SpanOptions,
  type Tracer,
  type TracingConfig,
} from "./tracing/types.js";
export { NoopSpan, NoopTracer } from "./tracing/noop.js";
export { OTelTracer } from "./tracing/otel.js";

// Memory / Persistent Context
export type {
  MemoryType,
  MemoryEntry,
  MemoryProvider,
  MemoryConfig,
} from "./memory/types.js";
export {
  FileMemoryProvider,
  truncateIndex,
  type IndexTruncation,
} from "./memory/file-provider.js";
export {
  buildMemorySystemPromptSection,
  buildExtractionPrompt,
} from "./memory/prompts.js";
export {
  extractMemories,
  type ExtractMemoriesResult,
} from "./memory/extraction.js";

// File Checkpointing
export type {
  FileCheckpointBackup,
  FileCheckpointSnapshot,
  FileCheckpointState,
  CheckpointConfig,
  DiffStats,
} from "./checkpoint/types.js";
export { createCheckpointState } from "./checkpoint/types.js";
export { FileCheckpointManager } from "./checkpoint/manager.js";

// Prompt Caching
export type {
  CacheScope,
  CacheControlConfig,
} from "./providers/cache.js";
export {
  sortToolDefinitionsForCache,
  getMessageCacheBreakpointIndex,
} from "./providers/cache.js";
export type { CacheSafeParams } from "./providers/cache-safe-params.js";
export {
  saveCacheSafeParams,
  getLastCacheSafeParams,
  createCacheSafeParams,
} from "./providers/cache-safe-params.js";

// Session Resume
export type { ResumePayload } from "./session/resume.js";
export { restoreSession } from "./session/resume.js";
export type { StoredCostState } from "./cost/tracker.js";

// New session types
export type { FileCheckpointEntry } from "./session/types.js";
