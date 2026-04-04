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

// Virtual infrastructure
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
} from "./tools/types.js";
export { ToolRegistry } from "./tools/registry.js";
export { readFileTool } from "./tools/read.js";
export { writeFileTool } from "./tools/write.js";
export { editFileTool } from "./tools/edit.js";
export { bashTool } from "./tools/bash.js";
export { globTool } from "./tools/glob.js";
export { grepTool } from "./tools/grep.js";

// Skills
export type { SkillDefinition } from "./skills/types.js";
export { loadSkills } from "./skills/loader.js";

// Compaction
export { compactConversation } from "./compact/compact.js";
export {
  createAutoCompactConfig,
  shouldAutoCompact,
  type AutoCompactConfig,
} from "./compact/auto-compact.js";

// System prompt
export { buildSystemPrompt } from "./prompt/system.js";
