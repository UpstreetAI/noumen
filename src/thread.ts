import type { AIProvider, ChatCompletionUsage } from "./providers/types.js";
import { truncateHeadForPTLRetry } from "./utils/tokens.js";
import type { VirtualFs } from "./virtual/fs.js";
import type { VirtualComputer } from "./virtual/computer.js";
import type {
  ChatMessage,
  AssistantMessage,
  ToolCallContent,
  ContentPart,
  StreamEvent,
  RunOptions,
} from "./session/types.js";
import type { SkillDefinition } from "./skills/types.js";
import type { ContextFile } from "./context/types.js";
import { buildProjectContextSection } from "./context/prompts.js";
import { activateContextForPaths, filterActiveContextFiles } from "./context/loader.js";
import type { Tool, ToolContext, SubagentConfig, SubagentRun } from "./tools/types.js";
import { createToolSearchTool, TOOL_SEARCH_NAME } from "./tools/tool-search.js";
import type { TaskStore } from "./tasks/store.js";
import type { LspServerManager } from "./lsp/manager.js";
import type {
  PermissionConfig,
  PermissionContext,
  PermissionHandler,
  PermissionRequest,
} from "./permissions/types.js";
import type { HookDefinition } from "./hooks/types.js";
import type { ThinkingConfig } from "./thinking/types.js";
import type { RetryConfig } from "./retry/types.js";
import type { CostTracker } from "./cost/tracker.js";
import type { Tracer, Span } from "./tracing/types.js";
import { SpanStatusCode } from "./tracing/types.js";
import { NoopTracer } from "./tracing/noop.js";
import type { MemoryConfig } from "./memory/types.js";
import { buildMemorySystemPromptSection } from "./memory/prompts.js";
import { extractMemories } from "./memory/extraction.js";
import type { FileCheckpointManager } from "./checkpoint/manager.js";
import { sortToolDefinitionsForCache } from "./providers/cache.js";
import { saveCacheSafeParams, createCacheSafeParams } from "./providers/cache-safe-params.js";
import { restoreSession } from "./session/resume.js";
import { generateMissingToolResults } from "./session/recovery.js";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runNotificationHooks,
} from "./hooks/runner.js";
import { ToolRegistry, resolveToolFlag } from "./tools/registry.js";
import { runToolsBatched, type ToolCallExecResult } from "./tools/orchestration.js";
import {
  StreamingToolExecutor,
  type StreamingExecResult,
} from "./tools/streaming-executor.js";
import { SessionStorage } from "./session/storage.js";
import { buildSystemPrompt } from "./prompt/system.js";
import { compactConversation } from "./compact/compact.js";
import {
  createAutoCompactConfig,
  shouldAutoCompact,
  canAutoCompact,
  recordAutoCompactSuccess,
  recordAutoCompactFailure,
  createAutoCompactTracking,
  type AutoCompactConfig,
  type AutoCompactTrackingState,
} from "./compact/auto-compact.js";
import {
  microcompactMessages,
  type MicrocompactConfig,
} from "./compact/microcompact.js";
import {
  enforceToolResultBudget,
  createBudgetState,
  type ToolResultBudgetConfig,
  type BudgetState,
} from "./compact/tool-result-budget.js";
import {
  persistToolResult,
  enforceToolResultStorageBudget,
  reconstructContentReplacementState,
  applyPersistedReplacements,
  createContentReplacementState,
  type ToolResultStorageConfig,
  type ContentReplacementState,
} from "./compact/tool-result-storage.js";
import {
  tryReactiveCompact,
  type ReactiveCompactConfig,
} from "./compact/reactive-compact.js";
import type { SnipConfig } from "./compact/history-snip.js";
import { contentToString } from "./utils/content.js";
import { FileStateCache } from "./file-state/cache.js";
import type { FileStateCacheConfig } from "./file-state/types.js";
import { generateUUID } from "./utils/uuid.js";
import { activateSkillsForPaths, getActiveSkills } from "./skills/activation.js";
import { createSkillTool } from "./tools/skill.js";
import { resolvePermission, type ResolvePermissionOptions } from "./permissions/pipeline.js";
import { DenialTracker } from "./permissions/denial-tracking.js";
import { withRetry, CannotRetryError, FallbackTriggeredError } from "./retry/engine.js";
import { classifyError } from "./retry/classify.js";

const FILE_TOOLS = new Set(["ReadFile", "WriteFile", "EditFile"]);

export interface ThreadOptions {
  sessionId?: string;
  resume?: boolean;
  cwd?: string;
  model?: string;
}

export interface ThreadConfig {
  aiProvider: AIProvider;
  fs: VirtualFs;
  computer: VirtualComputer;
  sessionDir: string;
  skills?: SkillDefinition[];
  tools?: Tool[];
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  autoCompact?: AutoCompactConfig;
  microcompact?: MicrocompactConfig;
  toolResultBudget?: ToolResultBudgetConfig;
  reactiveCompact?: ReactiveCompactConfig;
  permissions?: PermissionConfig;
  hooks?: HookDefinition[];
  spawnSubagent?: (config: SubagentConfig) => SubagentRun;
  streamingToolExecution?: boolean;
  userInputHandler?: (question: string) => Promise<string>;
  taskStore?: TaskStore;
  lspManager?: LspServerManager;
  thinking?: ThinkingConfig;
  retry?: RetryConfig;
  costTracker?: CostTracker;
  tracer?: Tracer;
  memory?: MemoryConfig;
  toolSearchEnabled?: boolean;
  checkpointManager?: FileCheckpointManager;
  /** File state cache config for read-before-edit enforcement. */
  fileStateCacheConfig?: FileStateCacheConfig;
  /** Disk-backed tool result storage config. */
  toolResultStorage?: ToolResultStorageConfig;
  /** History snip: enable middle-range removal from conversation history. */
  historySnip?: SnipConfig;
  /** Enable deterministic tool ordering and CacheSafeParams tracking for prompt caching. */
  promptCachingEnabled?: boolean;
  /** When true, signal skipCacheWrite to the provider (for subagent forks). */
  skipCacheWrite?: boolean;
  /** Set of MCP tool names for cache-stable sorting (built-in first, then MCP). */
  mcpToolNames?: ReadonlySet<string>;
  /** Loaded project context files (NOUMEN.md / CLAUDE.md) for system prompt injection. */
  projectContext?: ContextFile[];
}

export class Thread {
  readonly sessionId: string;

  private config: ThreadConfig;
  private storage: SessionStorage;
  private toolRegistry: ToolRegistry;
  private messages: ChatMessage[] = [];
  private loaded = false;
  private abortController: AbortController | null = null;
  private cwd: string;
  private model: string;
  private activatedSkills: Set<string> = new Set();
  private activatedContextRules: Set<string> = new Set();
  private permissionContext: PermissionContext | null = null;
  private permissionHandler: PermissionHandler | null = null;
  private hooks: HookDefinition[];
  private lastUsage: ChatCompletionUsage | undefined;
  private anchorMessageIndex: number | undefined;
  private prePlanMode: import("./permissions/types.js").PermissionMode | null = null;
  private tracer: Tracer;
  private autoCompactTracking: AutoCompactTrackingState;
  private budgetState: BudgetState;
  private hasAttemptedReactiveCompact = false;
  private microcompactTokensFreed = 0;
  private resumeRequested = false;
  private fileStateCache: FileStateCache | null = null;
  private contentReplacementState: ContentReplacementState;
  private denialTracker: DenialTracker | null = null;

  constructor(config: ThreadConfig, opts?: ThreadOptions) {
    this.config = config;
    this.sessionId = opts?.sessionId ?? generateUUID();
    this.cwd = opts?.cwd ?? "/";
    this.model = opts?.model ?? config.model ?? "gpt-4o";
    this.storage = new SessionStorage(config.fs, config.sessionDir);

    if (config.permissions) {
      this.permissionContext = {
        mode: config.permissions.mode ?? "default",
        rules: [...(config.permissions.rules ?? [])],
        workingDirectories: [...(config.permissions.workingDirectories ?? [])],
      };
      this.permissionHandler = config.permissions.handler ?? null;
      if (config.permissions.denialTracking) {
        this.denialTracker = new DenialTracker(config.permissions.denialTracking);
      }
    }

    const extraTools = [...(config.tools ?? [])];

    // Add the Skill tool when skills are configured
    const allSkills = config.skills ?? [];
    if (allSkills.length > 0) {
      extraTools.push(
        createSkillTool(() => getActiveSkills(allSkills, this.activatedSkills)),
      );
    }

    this.toolRegistry = new ToolRegistry(extraTools.length > 0 ? extraTools : undefined);
    if (config.toolSearchEnabled) {
      this.toolRegistry.enableToolSearch();
      const registry = this.toolRegistry;
      registry.register(
        createToolSearchTool(
          () => registry.getDeferredTools(),
          () => registry.listTools(),
          (names) => registry.getToolsByNames(names),
          (names) => registry.markDiscovered(names),
        ),
      );
    }
    this.hooks = config.hooks ?? [];
    this.tracer = config.tracer ?? new NoopTracer();
    this.autoCompactTracking = createAutoCompactTracking();
    this.budgetState = createBudgetState();

    if (config.fileStateCacheConfig?.enabled !== false) {
      this.fileStateCache = new FileStateCache(config.fileStateCacheConfig);
    }
    this.contentReplacementState = createContentReplacementState();

    if (opts?.resume) {
      this.loaded = false;
      this.resumeRequested = true;
    }
  }

  async *run(
    prompt: string | ContentPart[],
    opts?: RunOptions,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    this.abortController = new AbortController();
    const signal = opts?.signal ?? this.abortController.signal;

    const interactionSpan = this.tracer.startSpan("noumen.interaction", {
      attributes: {
        "session.id": this.sessionId,
        "model": this.model,
        "prompt.length": prompt.length,
      },
    });
    const interactionStart = Date.now();
    yield { type: "span_start", name: "noumen.interaction", spanId: this.sessionId };

    try {
      if (!this.loaded) {
        if (this.resumeRequested) {
          const payload = await restoreSession(this.storage, this.sessionId);
          this.messages = payload.messages;

          if (this.config.checkpointManager && payload.checkpointSnapshots.length > 0) {
            this.config.checkpointManager.restoreStateFromEntries(payload.checkpointSnapshots);
          }

          if (this.config.costTracker && payload.costState) {
            this.config.costTracker.restore(payload.costState);
          }

          // Reconstruct content replacement state and re-apply spilled stubs
          if (payload.contentReplacements.length > 0) {
            this.contentReplacementState = reconstructContentReplacementState(
              payload.contentReplacements,
              this.messages,
            );
            this.messages = applyPersistedReplacements(
              this.messages,
              this.contentReplacementState,
            );
          }

          // Emit recovery diagnostics
          for (const [filterName, count] of Object.entries(payload.recoveryRemovals)) {
            if (count > 0) {
              yield { type: "recovery_filtered", filterName, removedCount: count };
            }
          }

          if (payload.interruption.kind !== "none") {
            yield {
              type: "interrupted_turn_detected",
              kind: payload.interruption.kind,
            };
          }

          // Inject continuation prompt for interrupted tool turns
          if (payload.interruption.kind === "interrupted_tool") {
            const continuationMsg: ChatMessage = {
              role: "user",
              content: "Continue from where you left off.",
            };
            this.messages.push(continuationMsg);
            await this.storage.appendMessage(this.sessionId, continuationMsg);
          }

          this.resumeRequested = false;
          yield { type: "session_resumed", sessionId: this.sessionId, messageCount: this.messages.length };
        } else {
          this.messages = await this.storage.loadMessages(this.sessionId);
        }
        this.loaded = true;
      }

      const userMessage: ChatMessage = { role: "user", content: prompt };
      this.messages.push(userMessage);
      await this.storage.appendMessage(this.sessionId, userMessage);

      const turnMessageId = generateUUID();

      if (this.config.checkpointManager) {
        await this.config.checkpointManager.makeSnapshot(turnMessageId, this.sessionId);
        await this.storage.appendCheckpointEntry(
          this.sessionId,
          turnMessageId,
          this.config.checkpointManager.getState().snapshots.at(-1)!,
          false,
        );
        yield { type: "checkpoint_snapshot", messageId: turnMessageId };
      }

      const allSkills = this.config.skills ?? [];
      let systemPrompt = await this.buildCurrentSystemPromptAsync(allSkills);

      let toolDefs = this.config.toolSearchEnabled
        ? this.toolRegistry.getActiveToolDefinitions()
        : this.toolRegistry.toToolDefinitions();
      const toolCtx: ToolContext = {
        fs: this.config.fs,
        computer: this.config.computer,
        cwd: this.cwd,
        sessionId: this.sessionId,
        hooks: this.hooks,
        spawnSubagent: this.config.spawnSubagent,
        userInputHandler: this.config.userInputHandler,
        taskStore: this.config.taskStore,
        lspManager: this.config.lspManager,
        checkpointManager: this.config.checkpointManager,
        currentMessageId: turnMessageId,
        setPermissionMode: this.permissionContext
          ? (mode) => {
              if (this.permissionContext) {
                if (mode === "plan" && this.permissionContext.mode !== "plan") {
                  this.prePlanMode = this.permissionContext.mode;
                }
                if (mode !== "plan" && this.permissionContext.mode === "plan" && this.prePlanMode) {
                  this.permissionContext.mode = this.prePlanMode;
                  this.prePlanMode = null;
                } else {
                  this.permissionContext.mode = mode;
                }
              }
            }
          : undefined,
        getPermissionMode: this.permissionContext
          ? () => this.permissionContext!.mode
          : undefined,
        setCwd: (newCwd: string) => {
          this.cwd = newCwd;
          toolCtx.cwd = newCwd;
        },
        fileStateCache: this.fileStateCache ?? undefined,
      };

      const turnUsage: ChatCompletionUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
      let callCount = 0;
      let preventContinuation = false;
      const hooks = this.hooks;

      const useStreamingExec = this.config.streamingToolExecution ?? false;
      const retryConfig = this.config.retry;
      let currentMaxTokens = this.config.maxTokens;

      this.microcompactTokensFreed = 0;

      while (!signal.aborted) {
        // --- Pre-call compaction pipeline ---
        if (this.config.toolResultBudget?.enabled) {
          const budgetResult = enforceToolResultBudget(
            this.messages,
            this.config.toolResultBudget,
            this.budgetState,
          );
          this.messages = budgetResult.messages;
          this.budgetState = budgetResult.state;
          this.microcompactTokensFreed += budgetResult.tokensFreed;
          for (const entry of budgetResult.truncatedEntries) {
            yield {
              type: "tool_result_truncated",
              toolCallId: entry.toolCallId,
              originalChars: entry.originalChars,
              truncatedChars: entry.truncatedChars,
            };
          }
        }

        if (this.config.microcompact?.enabled) {
          const mcResult = microcompactMessages(this.messages, this.config.microcompact);
          if (mcResult.tokensFreed > 0) {
            this.messages = mcResult.messages;
            this.microcompactTokensFreed += mcResult.tokensFreed;
            yield { type: "microcompact_complete", tokensFreed: mcResult.tokensFreed };
          }
        }

        // --- TurnStart notification ---
        await runNotificationHooks(hooks, "TurnStart", {
          event: "TurnStart",
          sessionId: this.sessionId,
          messages: this.messages,
        });

        const accumulatedContent: string[] = [];
        const accumulatedToolCalls = new Map<
          number,
          { id: string; name: string; arguments: string; complete: boolean }
        >();
        let finishReason: string | null = null;
        let lastUsage: ChatCompletionUsage | undefined;

        let streamingExec: StreamingToolExecutor | null = null;
        const streamingResults: StreamingExecResult[] = [];

        if (useStreamingExec) {
          streamingExec = new StreamingToolExecutor(
            (name) => this.toolRegistry.get(name),
            this.buildStreamingExecutorFn(toolCtx, hooks),
          );
        }

        const sortedToolDefs = this.config.promptCachingEnabled
          ? sortToolDefinitionsForCache(toolDefs, this.config.mcpToolNames)
          : toolDefs;

        const chatParams = {
          model: this.model,
          messages: this.messages,
          tools: sortedToolDefs,
          system: systemPrompt,
          max_tokens: currentMaxTokens,
          thinking: this.config.thinking,
          skipCacheWrite: this.config.skipCacheWrite,
        };

        let stream: AsyncIterable<import("./providers/types.js").ChatStreamChunk>;

        const providerSpanId = generateUUID();
        const providerSpan = this.tracer.startSpan("noumen.provider.chat", {
          parent: interactionSpan,
          attributes: {
            "model": this.model,
            "messages.count": this.messages.length,
            "tools.count": toolDefs.length,
          },
        });
        yield { type: "span_start", name: "noumen.provider.chat", spanId: providerSpanId };
        const providerStart = Date.now();

        try {
        if (retryConfig) {
          const retryGen = withRetry(
            (ctx) => {
              const params = { ...chatParams };
              if (ctx.maxTokensOverride !== undefined) {
                params.max_tokens = ctx.maxTokensOverride;
              }
              if (ctx.model !== chatParams.model) {
                params.model = ctx.model;
              }
              return this.config.aiProvider.chat(params);
            },
            {
              ...retryConfig,
              model: this.model,
              thinkingBudget:
                this.config.thinking?.type === "enabled"
                  ? this.config.thinking.budgetTokens
                  : undefined,
              signal,
            },
          );

          let retryResult = await retryGen.next();
          while (!retryResult.done) {
            const event = retryResult.value;
            yield event;
            retryResult = await retryGen.next();
          }

          stream = retryResult.value;
          if (retryResult.value === undefined) break;
        } else {
          stream = this.config.aiProvider.chat(chatParams);
        }
        } catch (providerErr) {
          // Reactive compact: recover from context overflow by compacting
          const isOverflow =
            (providerErr instanceof CannotRetryError &&
              classifyError(providerErr.originalError).isContextOverflow) ||
            (!retryConfig && classifyError(providerErr).isContextOverflow);

          if (
            isOverflow &&
            this.config.reactiveCompact?.enabled &&
            !this.hasAttemptedReactiveCompact
          ) {
            this.hasAttemptedReactiveCompact = true;
            providerSpan.setStatus(SpanStatusCode.ERROR, "context overflow — reactive compact");
            providerSpan.end();
            yield { type: "span_end", name: "noumen.provider.chat", spanId: providerSpanId, durationMs: Date.now() - providerStart, error: "context overflow" };

            yield { type: "compact_start" };
            const recovered = await tryReactiveCompact(
              this.config.aiProvider,
              this.model,
              this.messages,
              this.storage,
              this.sessionId,
            );
            if (recovered) {
              this.messages = recovered.messages;
              this.lastUsage = undefined;
              this.anchorMessageIndex = undefined;
              yield { type: "compact_complete" };
              continue;
            }
            yield { type: "compact_complete" };
          }

          // Generate synthetic tool results for any pending tool_calls before re-throwing
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg && lastMsg.role === "assistant" && (lastMsg as AssistantMessage).tool_calls) {
            const syntheticResults = generateMissingToolResults(
              lastMsg as AssistantMessage,
              this.messages,
              `Provider error: ${providerErr instanceof Error ? providerErr.message : String(providerErr)}`,
            );
            for (const sr of syntheticResults) {
              this.messages.push(sr);
              await this.storage.appendMessage(this.sessionId, sr);
            }
          }

          throw providerErr;
        }

        const apiStartTime = Date.now();

        for await (const chunk of stream) {
          if (signal.aborted) break;

          if (chunk.usage) {
            lastUsage = chunk.usage;
          }

          for (const choice of chunk.choices) {
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta;

            if (delta.thinking_content) {
              yield { type: "thinking_delta", text: delta.thinking_content };
            }

            if (delta.content) {
              accumulatedContent.push(delta.content);
              yield { type: "text_delta", text: delta.content };
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = accumulatedToolCalls.get(tc.index);

                if (!existing) {
                  const id = tc.id ?? "";
                  const name = tc.function?.name ?? "";
                  accumulatedToolCalls.set(tc.index, {
                    id,
                    name,
                    arguments: tc.function?.arguments ?? "",
                    complete: false,
                  });

                  if (tc.id && tc.function?.name) {
                    yield {
                      type: "tool_use_start",
                      toolName: name,
                      toolUseId: id,
                    };
                  }

                  if (streamingExec && tc.index > 0) {
                    const prevTc = accumulatedToolCalls.get(tc.index - 1);
                    if (prevTc && !prevTc.complete) {
                      prevTc.complete = true;
                      let parsedArgs: Record<string, unknown> = {};
                      try { parsedArgs = JSON.parse(prevTc.arguments); } catch {}
                      streamingExec.addTool(
                        { id: prevTc.id, type: "function", function: { name: prevTc.name, arguments: prevTc.arguments } },
                        parsedArgs,
                      );
                    }
                  }
                } else {
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name = tc.function.name;
                  if (tc.function?.arguments) {
                    existing.arguments += tc.function.arguments;
                    yield {
                      type: "tool_use_delta",
                      input: tc.function.arguments,
                    };
                  }
                }
              }
            }
          }

          if (streamingExec) {
            for (const result of streamingExec.getCompletedResults()) {
              streamingResults.push(result);
            }
          }
        }

        const apiDurationMs = Date.now() - apiStartTime;

        if (streamingExec) {
          for (const [, tc] of accumulatedToolCalls) {
            if (!tc.complete) {
              tc.complete = true;
              let parsedArgs: Record<string, unknown> = {};
              try { parsedArgs = JSON.parse(tc.arguments); } catch {}
              streamingExec.addTool(
                { id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } },
                parsedArgs,
              );
            }
          }
        }

        if (signal.aborted) {
          providerSpan.setStatus(SpanStatusCode.OK);
          providerSpan.end();
          yield { type: "span_end", name: "noumen.provider.chat", spanId: providerSpanId, durationMs: Date.now() - providerStart };

          // Generate synthetic results for any tool_calls accumulated before abort
          const partialToolCalls: ToolCallContent[] = Array.from(accumulatedToolCalls.values()).map((tc) => ({
            id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments },
          }));
          if (partialToolCalls.length > 0) {
            const partialAssistant: AssistantMessage = {
              role: "assistant",
              content: accumulatedContent.join("") || null,
              tool_calls: partialToolCalls,
            };
            this.messages.push(partialAssistant);
            await this.storage.appendMessage(this.sessionId, partialAssistant);

            const syntheticResults = generateMissingToolResults(partialAssistant, [], "Interrupted by abort");
            for (const sr of syntheticResults) {
              this.messages.push(sr);
              await this.storage.appendMessage(this.sessionId, sr);
            }
          }
          break;
        }

        callCount++;
        if (lastUsage) {
          turnUsage.prompt_tokens += lastUsage.prompt_tokens;
          turnUsage.completion_tokens += lastUsage.completion_tokens;
          turnUsage.total_tokens += lastUsage.total_tokens;
          this.lastUsage = lastUsage;
          this.anchorMessageIndex = this.messages.length - 1;
          yield { type: "usage", usage: lastUsage, model: this.model };

          if (this.config.costTracker) {
            const summary = this.config.costTracker.addUsage(
              this.model,
              lastUsage,
              apiDurationMs,
            );
            yield { type: "cost_update", summary };
          }

          providerSpan.setAttribute("tokens.input", lastUsage.prompt_tokens);
          providerSpan.setAttribute("tokens.output", lastUsage.completion_tokens);
        }

        if (this.config.promptCachingEnabled) {
          saveCacheSafeParams(
            createCacheSafeParams({
              systemPrompt,
              model: this.model,
              tools: sortedToolDefs,
              thinking: this.config.thinking,
            }),
          );
        }

        providerSpan.setStatus(SpanStatusCode.OK);
        providerSpan.end();
        yield { type: "span_end", name: "noumen.provider.chat", spanId: providerSpanId, durationMs: Date.now() - providerStart };

        const textContent = accumulatedContent.join("");
        const toolCalls: ToolCallContent[] = Array.from(
          accumulatedToolCalls.values(),
        ).map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));

        const assistantMsg: AssistantMessage = {
          role: "assistant",
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };

        this.messages.push(assistantMsg);
        await this.storage.appendMessage(this.sessionId, assistantMsg);

        if (
          toolCalls.length > 0 &&
          (finishReason === "tool_calls" || finishReason === "stop" || !finishReason)
        ) {
          const touchedFilePaths: string[] = [];
          const registry = this.toolRegistry;
          const storage = this.storage;
          const sessionId = this.sessionId;
          const messages = this.messages;

          // Choose execution path: streaming (already started) or batched (post-stream)
          if (streamingExec) {
            // Collect any results that were already gathered during streaming
            const allResults = [...streamingResults];
            for await (const result of streamingExec.getRemainingResults()) {
              allResults.push(result);
            }

            const spilledRecords: import("./compact/tool-result-storage.js").ContentReplacementRecord[] = [];

            for (const execResult of allResults) {
              for (const evt of execResult.events) {
                yield evt;
              }

              if (!execResult.permissionDenied) {
                yield {
                  type: "tool_result",
                  toolUseId: execResult.toolCall.id,
                  toolName: execResult.toolCall.function.name,
                  result: execResult.result,
                };

                // Emit git operation events from bash tool results
                const gitOps = execResult.result.metadata?.gitOperations as
                  | Array<{ type: string; details: string }>
                  | undefined;
                if (gitOps) {
                  for (const op of gitOps) {
                    yield {
                      type: "git_operation" as const,
                      operation: op.type as "commit" | "push" | "pr_create" | "merge" | "rebase",
                      details: op.details,
                    };
                  }
                }
              }

              if (execResult.preventContinuation) {
                preventContinuation = true;
              }

              // Spill oversized results to disk before appending to messages
              let resultContent = execResult.result.content;
              if (typeof resultContent === "string") {
                const spill = await this.maybeSpillToolResult(
                  execResult.toolCall.id,
                  execResult.toolCall.function.name,
                  resultContent,
                );
                if (spill.spilled) {
                  resultContent = spill.content;
                  spilledRecords.push({ toolUseId: execResult.toolCall.id, replacement: spill.content });
                }
              }

              const toolResultMsg: ChatMessage = {
                role: "tool",
                tool_call_id: execResult.toolCall.id,
                content: resultContent,
              };
              messages.push(toolResultMsg);
              await storage.appendMessage(sessionId, toolResultMsg);

              if (
                FILE_TOOLS.has(execResult.toolCall.function.name) &&
                typeof execResult.parsedArgs.file_path === "string"
              ) {
                touchedFilePaths.push(execResult.parsedArgs.file_path);
              }
            }

            // Persist content replacement records for resume
            if (spilledRecords.length > 0) {
              await storage.appendContentReplacement(sessionId, spilledRecords);
            }
          } else {
            // Batched execution (original path)
            const permCtx = this.permissionContext;
            const permHandler = this.permissionHandler;
            const eventQueue: StreamEvent[] = [];

            const executor = async (
            tc: ToolCallContent,
            parsedArgs: Record<string, unknown>,
          ): Promise<ToolCallExecResult> => {
            let currentArgs = parsedArgs;

            // --- Permission gate ---
            if (permCtx) {
              const tool = registry.get(tc.function.name);
              if (tool) {
                const decision = await resolvePermission(
                  tool,
                  currentArgs,
                  toolCtx,
                  permCtx,
                  this.buildPermissionOpts(),
                );

                if (decision.behavior === "deny") {
                  this.denialTracker?.recordDenial();
                  eventQueue.push({
                    type: "permission_denied",
                    toolName: tc.function.name,
                    input: currentArgs,
                    message: decision.message,
                  });
                  if (this.denialTracker?.shouldFallback()) {
                    const state = this.denialTracker.getState();
                    eventQueue.push({
                      type: "denial_limit_exceeded",
                      consecutiveDenials: state.consecutiveDenials,
                      totalDenials: state.totalDenials,
                    });
                    preventContinuation = true;
                  }
                  const content = `Permission denied: ${decision.message}`;
                  return { toolCall: tc, parsedArgs: currentArgs, result: { content, isError: true }, permissionDenied: true };
                }

                if (decision.behavior === "ask") {
                  eventQueue.push({
                    type: "permission_request",
                    toolName: tc.function.name,
                    input: currentArgs,
                    message: decision.message,
                  });

                  if (permHandler) {
                    const isReadOnly = resolveToolFlag(tool.isReadOnly, currentArgs);
                    const isDestructive = resolveToolFlag(tool.isDestructive, currentArgs);
                    const request: PermissionRequest = {
                      toolName: tc.function.name,
                      input: currentArgs,
                      message: decision.message,
                      suggestions: decision.suggestions,
                      isReadOnly,
                      isDestructive,
                    };
                    const response = await permHandler(request);

                    if (!response.allow) {
                      this.denialTracker?.recordDenial();
                      const feedback = response.feedback ?? "User denied permission.";
                      eventQueue.push({
                        type: "permission_denied",
                        toolName: tc.function.name,
                        input: currentArgs,
                        message: feedback,
                      });
                      if (this.denialTracker?.shouldFallback()) {
                        const state = this.denialTracker.getState();
                        eventQueue.push({
                          type: "denial_limit_exceeded",
                          consecutiveDenials: state.consecutiveDenials,
                          totalDenials: state.totalDenials,
                        });
                        preventContinuation = true;
                      }
                      const content = `Permission denied: ${feedback}`;
                      return { toolCall: tc, parsedArgs: currentArgs, result: { content, isError: true }, permissionDenied: true };
                    }

                    if (response.updatedInput) {
                      currentArgs = response.updatedInput;
                    }
                    if (response.addRules) {
                      permCtx.rules.push(...response.addRules);
                    }
                  } else {
                    this.denialTracker?.recordDenial();
                    eventQueue.push({
                      type: "permission_denied",
                      toolName: tc.function.name,
                      input: currentArgs,
                      message: "No permission handler configured.",
                    });
                    if (this.denialTracker?.shouldFallback()) {
                      const state = this.denialTracker.getState();
                      eventQueue.push({
                        type: "denial_limit_exceeded",
                        consecutiveDenials: state.consecutiveDenials,
                        totalDenials: state.totalDenials,
                      });
                      preventContinuation = true;
                    }
                    const content = "Permission denied: No permission handler configured.";
                    return { toolCall: tc, parsedArgs: currentArgs, result: { content, isError: true }, permissionDenied: true };
                  }
                }

                this.denialTracker?.recordSuccess();
                eventQueue.push({
                  type: "permission_granted",
                  toolName: tc.function.name,
                  input: currentArgs,
                });
              }
            }

            // --- PreToolUse hooks ---
            if (hooks.length > 0) {
              const hookOutput = await runPreToolUseHooks(hooks, {
                event: "PreToolUse",
                toolName: tc.function.name,
                toolInput: currentArgs,
                toolUseId: tc.id,
                sessionId,
              });

              if (hookOutput.decision === "deny") {
                const msg = hookOutput.message ?? "Blocked by hook.";
                return { toolCall: tc, parsedArgs: currentArgs, result: { content: `Hook denied: ${msg}`, isError: true }, permissionDenied: true };
              }
              if (hookOutput.updatedInput) {
                currentArgs = hookOutput.updatedInput;
              }
              if (hookOutput.preventContinuation) {
                preventContinuation = true;
              }
            }

            const toolSpan = this.tracer.startSpan("noumen.tool.execute", {
              parent: interactionSpan,
              attributes: { "tool.name": tc.function.name, "tool.id": tc.id },
            });
            let result = await registry.execute(
              tc.function.name,
              currentArgs,
              toolCtx,
            );
            const resultText = contentToString(result.content);
            toolSpan.setStatus(result.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK, result.isError ? resultText : undefined);
            toolSpan.end();

            // --- PostToolUse hooks ---
            if (hooks.length > 0) {
              const postOutput = await runPostToolUseHooks(hooks, {
                event: "PostToolUse",
                toolName: tc.function.name,
                toolInput: currentArgs,
                toolUseId: tc.id,
                toolOutput: resultText,
                isError: result.isError ?? false,
                sessionId,
              });

              if (postOutput.updatedOutput !== undefined) {
                result = { ...result, content: postOutput.updatedOutput };
              }
              if (postOutput.preventContinuation) {
                preventContinuation = true;
              }
            }

            return { toolCall: tc, parsedArgs: currentArgs, result };
          };

          const batchSpilledRecords: import("./compact/tool-result-storage.js").ContentReplacementRecord[] = [];

          for await (const execResult of runToolsBatched(
            toolCalls,
            (name) => registry.get(name),
            executor,
          )) {
            // Flush queued permission events
            for (const evt of eventQueue) {
              yield evt;
            }
            eventQueue.length = 0;

            const { toolCall: tc, parsedArgs: finalArgs, result, permissionDenied } = execResult;

            if (!permissionDenied) {
              yield {
                type: "tool_result",
                toolUseId: tc.id,
                toolName: tc.function.name,
                result,
              };

              // Emit git operation events from bash tool results
              const gitOps = result.metadata?.gitOperations as
                | Array<{ type: string; details: string }>
                | undefined;
              if (gitOps) {
                for (const op of gitOps) {
                  yield {
                    type: "git_operation" as const,
                    operation: op.type as "commit" | "push" | "pr_create" | "merge" | "rebase",
                    details: op.details,
                  };
                }
              }
            }

            // Spill oversized results to disk before appending to messages
            let resultContent = result.content;
            if (typeof resultContent === "string") {
              const spill = await this.maybeSpillToolResult(tc.id, tc.function.name, resultContent);
              if (spill.spilled) {
                resultContent = spill.content;
                batchSpilledRecords.push({ toolUseId: tc.id, replacement: spill.content });
              }
            }

            const toolResultMsg: ChatMessage = {
              role: "tool",
              tool_call_id: tc.id,
              content: resultContent,
            };

            messages.push(toolResultMsg);
            await storage.appendMessage(sessionId, toolResultMsg);

            if (FILE_TOOLS.has(tc.function.name) && typeof finalArgs.file_path === "string") {
              touchedFilePaths.push(finalArgs.file_path);
            }
          }

            // Flush any remaining permission events
            for (const evt of eventQueue) {
              yield evt;
            }
            eventQueue.length = 0;

            // Persist content replacement records for resume
            if (batchSpilledRecords.length > 0) {
              await storage.appendContentReplacement(sessionId, batchSpilledRecords);
            }
          }

          if (touchedFilePaths.length > 0) {
            let needsRebuild = false;

            if (allSkills.length > 0) {
              const newlyActivated = activateSkillsForPaths(
                allSkills,
                touchedFilePaths,
                this.cwd,
                this.activatedSkills,
              );
              if (newlyActivated.length > 0) needsRebuild = true;
            }

            if (this.config.projectContext?.length) {
              const newCtx = activateContextForPaths(
                this.config.projectContext,
                touchedFilePaths,
                this.cwd,
                this.activatedContextRules,
              );
              if (newCtx.length > 0) needsRebuild = true;
            }

            if (needsRebuild) {
              systemPrompt = await this.buildCurrentSystemPromptAsync(allSkills);
            }
          }

          if (this.config.toolSearchEnabled) {
            toolDefs = this.toolRegistry.getActiveToolDefinitions();
          }

          if (preventContinuation) break;
          continue;
        }

        yield { type: "message_complete", message: assistantMsg };

        await runNotificationHooks(hooks, "TurnEnd", {
          event: "TurnEnd",
          sessionId: this.sessionId,
        });

        yield {
          type: "turn_complete",
          usage: turnUsage,
          model: this.model,
          callCount,
        };
        break;
      }

      // --- Memory extraction ---
      const memCfg = this.config.memory;
      if (memCfg && memCfg.autoExtract && memCfg.provider) {
        try {
          const extractResult = await extractMemories(
            this.config.aiProvider,
            this.model,
            this.messages,
            memCfg.provider,
          );
          const hasChanges = extractResult.created.length > 0
            || extractResult.updated.length > 0
            || extractResult.deleted.length > 0;
          if (hasChanges) {
            yield {
              type: "memory_update",
              created: extractResult.created,
              updated: extractResult.updated,
              deleted: extractResult.deleted,
            };
          }
        } catch {
          // Memory extraction is best-effort; don't fail the turn.
        }
      }

      // --- Compaction with hooks (model-aware + circuit breaker) ---
      const autoCompactConfig =
        this.config.autoCompact ?? createAutoCompactConfig({ model: this.model });
      if (
        canAutoCompact(this.autoCompactTracking) &&
        shouldAutoCompact(
          this.messages,
          autoCompactConfig,
          this.lastUsage,
          this.anchorMessageIndex,
          this.microcompactTokensFreed,
        )
      ) {
        await runNotificationHooks(hooks, "PreCompact", {
          event: "PreCompact",
          sessionId: this.sessionId,
        });

        const compactSpanId = generateUUID();
        const compactSpan = this.tracer.startSpan("noumen.compact", {
          parent: interactionSpan,
          attributes: { "messages.before": this.messages.length },
        });
        const compactStart = Date.now();
        yield { type: "span_start", name: "noumen.compact", spanId: compactSpanId };

        yield { type: "compact_start" };
        try {
          this.messages = await compactConversation(
            this.config.aiProvider,
            this.model,
            this.messages,
            this.storage,
            this.sessionId,
            {
              tailMessagesToKeep: autoCompactConfig.tailMessagesToKeep,
              stripBinaryContent: true,
            },
          );
          this.lastUsage = undefined;
          this.anchorMessageIndex = undefined;
          recordAutoCompactSuccess(this.autoCompactTracking);

          compactSpan.setAttribute("messages.after", this.messages.length);
          compactSpan.setStatus(SpanStatusCode.OK);
          compactSpan.end();
          yield { type: "span_end", name: "noumen.compact", spanId: compactSpanId, durationMs: Date.now() - compactStart };

          yield { type: "compact_complete" };

          await runNotificationHooks(hooks, "PostCompact", {
            event: "PostCompact",
            sessionId: this.sessionId,
          });
        } catch (err) {
          recordAutoCompactFailure(this.autoCompactTracking);

          const error = err instanceof Error
            ? err
            : new Error(`Compaction failed: ${String(err)}`);

          compactSpan.setStatus(SpanStatusCode.ERROR, error.message);
          compactSpan.end();
          yield { type: "span_end", name: "noumen.compact", spanId: compactSpanId, durationMs: Date.now() - compactStart, error: error.message };

          await runNotificationHooks(hooks, "Error", {
            event: "Error",
            sessionId: this.sessionId,
            error,
          });

          yield { type: "error", error };
        }
      }

      interactionSpan.setStatus(SpanStatusCode.OK);
      interactionSpan.end();
      yield { type: "span_end", name: "noumen.interaction", spanId: this.sessionId, durationMs: Date.now() - interactionStart };
    } catch (err) {
      if (!signal.aborted) {
        const error = err instanceof Error ? err : new Error(String(err));

        interactionSpan.setStatus(SpanStatusCode.ERROR, error.message);
        interactionSpan.end();
        yield { type: "span_end", name: "noumen.interaction", spanId: this.sessionId, durationMs: Date.now() - interactionStart, error: error.message };

        await runNotificationHooks(this.hooks, "Error", {
          event: "Error",
          sessionId: this.sessionId,
          error,
        });

        yield { type: "error", error };
      } else {
        interactionSpan.setStatus(SpanStatusCode.OK);
        interactionSpan.end();
        yield { type: "span_end", name: "noumen.interaction", spanId: this.sessionId, durationMs: Date.now() - interactionStart };
      }
    }
  }

  /**
   * If tool result storage is enabled and the content exceeds the threshold,
   * spill to disk and return the replacement stub. Otherwise return the original.
   */
  private async maybeSpillToolResult(
    toolUseId: string,
    toolName: string,
    content: string,
  ): Promise<{ content: string; spilled: boolean }> {
    const storageConfig = this.config.toolResultStorage;
    if (!storageConfig?.enabled) return { content, spilled: false };

    const replacement = await persistToolResult(
      this.config.fs,
      this.sessionId,
      toolUseId,
      toolName,
      content,
      storageConfig,
    );

    if (replacement) {
      this.contentReplacementState.seenIds.add(toolUseId);
      this.contentReplacementState.replacements.set(toolUseId, replacement);
      return { content: replacement, spilled: true };
    }

    this.contentReplacementState.seenIds.add(toolUseId);
    return { content, spilled: false };
  }

  private buildStreamingExecutorFn(
    toolCtx: ToolContext,
    hooks: HookDefinition[],
  ): import("./tools/streaming-executor.js").StreamingToolExecutorFn {
    const permCtx = this.permissionContext;
    const permHandler = this.permissionHandler;
    const registry = this.toolRegistry;
    const sessionId = this.sessionId;

    return async (tc, parsedArgs) => {
      let currentArgs = parsedArgs;
      const events: StreamEvent[] = [];

      if (permCtx) {
        const tool = registry.get(tc.function.name);
        if (tool) {
          const decision = await resolvePermission(tool, currentArgs, toolCtx, permCtx, this.buildPermissionOpts());

          if (decision.behavior === "deny") {
            this.denialTracker?.recordDenial();
            events.push({ type: "permission_denied", toolName: tc.function.name, input: currentArgs, message: decision.message });
            if (this.denialTracker?.shouldFallback()) {
              const state = this.denialTracker.getState();
              events.push({ type: "denial_limit_exceeded", consecutiveDenials: state.consecutiveDenials, totalDenials: state.totalDenials });
            }
            return { result: { content: `Permission denied: ${decision.message}`, isError: true }, permissionDenied: true, preventContinuation: this.denialTracker?.shouldFallback() || undefined, events };
          }

          if (decision.behavior === "ask") {
            events.push({ type: "permission_request", toolName: tc.function.name, input: currentArgs, message: decision.message });
            if (permHandler) {
              const isReadOnly = resolveToolFlag(tool.isReadOnly, currentArgs);
              const isDestructive = resolveToolFlag(tool.isDestructive, currentArgs);
              const response = await permHandler({
                toolName: tc.function.name,
                input: currentArgs,
                message: decision.message,
                suggestions: decision.suggestions,
                isReadOnly,
                isDestructive,
              });
              if (!response.allow) {
                this.denialTracker?.recordDenial();
                const feedback = response.feedback ?? "User denied permission.";
                events.push({ type: "permission_denied", toolName: tc.function.name, input: currentArgs, message: feedback });
                if (this.denialTracker?.shouldFallback()) {
                  const state = this.denialTracker.getState();
                  events.push({ type: "denial_limit_exceeded", consecutiveDenials: state.consecutiveDenials, totalDenials: state.totalDenials });
                }
                return { result: { content: `Permission denied: ${feedback}`, isError: true }, permissionDenied: true, preventContinuation: this.denialTracker?.shouldFallback() || undefined, events };
              }
              if (response.updatedInput) currentArgs = response.updatedInput;
              if (response.addRules) permCtx.rules.push(...response.addRules);
            } else {
              this.denialTracker?.recordDenial();
              events.push({ type: "permission_denied", toolName: tc.function.name, input: currentArgs, message: "No permission handler configured." });
              if (this.denialTracker?.shouldFallback()) {
                const state = this.denialTracker.getState();
                events.push({ type: "denial_limit_exceeded", consecutiveDenials: state.consecutiveDenials, totalDenials: state.totalDenials });
              }
              return { result: { content: "Permission denied: No permission handler configured.", isError: true }, permissionDenied: true, preventContinuation: this.denialTracker?.shouldFallback() || undefined, events };
            }
          }

          this.denialTracker?.recordSuccess();
          events.push({ type: "permission_granted", toolName: tc.function.name, input: currentArgs });
        }
      }

      let hookPreventContinuation = false;

      if (hooks.length > 0) {
        const hookOutput = await runPreToolUseHooks(hooks, {
          event: "PreToolUse", toolName: tc.function.name, toolInput: currentArgs, toolUseId: tc.id, sessionId,
        });
        if (hookOutput.decision === "deny") {
          return { result: { content: `Hook denied: ${hookOutput.message ?? "Blocked by hook."}`, isError: true }, permissionDenied: true, events };
        }
        if (hookOutput.updatedInput) currentArgs = hookOutput.updatedInput;
        if (hookOutput.preventContinuation) hookPreventContinuation = true;
      }

      const toolSpan = this.tracer.startSpan("noumen.tool.execute", {
        attributes: { "tool.name": tc.function.name, "tool.id": tc.id },
      });
      let result = await registry.execute(tc.function.name, currentArgs, toolCtx);
      const streamResultText = contentToString(result.content);
      toolSpan.setStatus(result.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK, result.isError ? streamResultText : undefined);
      toolSpan.end();

      if (hooks.length > 0) {
        const postOutput = await runPostToolUseHooks(hooks, {
          event: "PostToolUse", toolName: tc.function.name, toolInput: currentArgs, toolUseId: tc.id, toolOutput: streamResultText, isError: result.isError ?? false, sessionId,
        });
        if (postOutput.updatedOutput !== undefined) {
          result = { ...result, content: postOutput.updatedOutput };
        }
        if (postOutput.preventContinuation) hookPreventContinuation = true;
      }

      return { result, preventContinuation: hookPreventContinuation || undefined, events };
    };
  }

  private buildPermissionOpts(): ResolvePermissionOptions | undefined {
    const autoMode = this.config.permissions?.autoMode;
    if (!autoMode) return undefined;
    const tail = this.messages.slice(-10);
    return {
      aiProvider: this.config.aiProvider,
      model: this.model,
      recentMessages: tail,
      autoModeConfig: autoMode,
    };
  }

  private async buildCurrentSystemPromptAsync(allSkills: SkillDefinition[]): Promise<string> {
    const activeSkills = getActiveSkills(allSkills, this.activatedSkills);
    let memorySection: string | undefined;

    const memCfg = this.config.memory;
    if (memCfg?.provider && memCfg.injectIntoSystemPrompt !== false) {
      try {
        const indexContent = await memCfg.provider.loadIndex();
        memorySection = buildMemorySystemPromptSection(indexContent, "(memory)");
      } catch {
        // If memory loading fails, proceed without it.
      }
    }

    let projectContextSection: string | undefined;
    if (this.config.projectContext?.length) {
      const active = filterActiveContextFiles(
        this.config.projectContext,
        [],
        this.cwd,
      );
      const unconditional = active.filter((f) => !f.globs || f.globs.length === 0);
      const activatedConditional = this.config.projectContext.filter(
        (f) => f.globs && f.globs.length > 0 && this.activatedContextRules.has(f.path),
      );
      const combined = [...unconditional, ...activatedConditional];
      if (combined.length > 0) {
        projectContextSection = buildProjectContextSection(combined);
      }
    }

    const deferredTools = this.config.toolSearchEnabled
      ? this.toolRegistry.getDeferredTools().map((t) => ({
          name: t.name,
          description: t.description,
        }))
      : undefined;

    return buildSystemPrompt({
      customPrompt: this.config.systemPrompt,
      skills: activeSkills,
      tools: this.toolRegistry.listTools(),
      projectContext: projectContextSection,
      memorySection,
      deferredTools: deferredTools?.length ? deferredTools : undefined,
    });
  }

  async getMessages(): Promise<ChatMessage[]> {
    if (!this.loaded) {
      if (this.resumeRequested) {
        const payload = await restoreSession(this.storage, this.sessionId);
        this.messages = payload.messages;
        if (this.config.checkpointManager && payload.checkpointSnapshots.length > 0) {
          this.config.checkpointManager.restoreStateFromEntries(payload.checkpointSnapshots);
        }
        if (this.config.costTracker && payload.costState) {
          this.config.costTracker.restore(payload.costState);
        }
        this.resumeRequested = false;
      } else {
        this.messages = await this.storage.loadMessages(this.sessionId);
      }
      this.loaded = true;
    }
    return [...this.messages];
  }

  async compact(opts?: { instructions?: string }): Promise<void> {
    if (!this.loaded) {
      this.messages = await this.storage.loadMessages(this.sessionId);
      this.loaded = true;
    }

    this.messages = await compactConversation(
      this.config.aiProvider,
      this.model,
      this.messages,
      this.storage,
      this.sessionId,
      { customInstructions: opts?.instructions },
    );
    this.lastUsage = undefined;
    this.anchorMessageIndex = undefined;
  }

  /**
   * Remove specific messages from the middle of conversation history.
   *
   * Unlike `compact()` which summarizes a prefix, `snip()` removes
   * specific messages by UUID. The JSONL transcript records the removed
   * UUIDs so they're filtered on resume. Parent pointers are relinked
   * across gaps.
   *
   * @param uuids - UUIDs of messages to remove
   */
  async snip(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;
    await this.storage.appendSnipBoundary(this.sessionId, uuids);

    // Rebuild messages from entries with snip applied
    const entries = await this.storage.loadAllEntries(this.sessionId);
    const { applySnipRemovals } = await import("./compact/history-snip.js");

    let lastBoundaryIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "compact-boundary") {
        lastBoundaryIdx = i;
        break;
      }
    }

    const activeEntries = entries.slice(lastBoundaryIdx + 1);
    const result = applySnipRemovals(activeEntries);
    this.messages = result.messages;
  }

  abort(): void {
    this.abortController?.abort();
  }
}
