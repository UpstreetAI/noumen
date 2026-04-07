import type { AIProvider, ChatCompletionUsage, OutputFormat } from "./providers/types.js";
import type { VirtualFs } from "./virtual/fs.js";
import type { VirtualComputer } from "./virtual/computer.js";
import type {
  ChatMessage,
  AssistantMessage,
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
  runNotificationHooks,
} from "./hooks/runner.js";
import { ToolRegistry } from "./tools/registry.js";
import {
  StreamingToolExecutor,
  type StreamingExecResult,
} from "./tools/streaming-executor.js";
import {
  executeToolCall,
  type ToolExecutionContext,
} from "./tools/execution-pipeline.js";
import { SessionStorage } from "./session/storage.js";
import { buildSystemPrompt } from "./prompt/system.js";
import { compactConversation } from "./compact/compact.js";
import {
  createAutoCompactConfig,
  recordAutoCompactSuccess,
  createAutoCompactTracking,
  type AutoCompactConfig,
  type AutoCompactTrackingState,
} from "./compact/auto-compact.js";
import {
  type MicrocompactConfig,
} from "./compact/microcompact.js";
import {
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
  type ReactiveCompactConfig,
} from "./compact/reactive-compact.js";
import { prepareMessagesForApi } from "./pipeline/prepare-messages.js";
import { tryAutoCompactStep } from "./pipeline/auto-compact-step.js";
import { executeToolsStep } from "./pipeline/execute-tools-step.js";
import {
  buildPartialResults,
  tryReactiveCompactRecovery as tryReactiveCompactRecoveryFn,
} from "./pipeline/error-recovery.js";
import {
  createAccumulator,
  resetAccumulator,
  consumeStream,
  handleFinishReason,
} from "./pipeline/consume-stream.js";
import {
  separateToolCalls,
  buildAssistantMessage,
  generateMalformedToolResults,
  accumulateUsage,
} from "./pipeline/build-assistant-response.js";
import type { SnipConfig } from "./compact/history-snip.js";
import { FileStateCache } from "./file-state/cache.js";
import type { FileStateCacheConfig } from "./file-state/types.js";
import { generateUUID } from "./utils/uuid.js";
import { activateSkillsForPaths, getActiveSkills } from "./skills/activation.js";
import { createSkillTool } from "./tools/skill.js";
import type { ResolvePermissionOptions } from "./permissions/pipeline.js";
import { DenialTracker } from "./permissions/denial-tracking.js";
import { withRetry, CannotRetryError } from "./retry/engine.js";
import { classifyError } from "./retry/classify.js";
import {
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "./tools/structured-output.js";

export interface ThreadOptions {
  sessionId?: string;
  resume?: boolean;
  cwd?: string;
  model?: string;
  /** Override the permission handler for this thread (takes precedence over AgentOptions). */
  permissionHandler?: PermissionHandler;
  /** Override the user input handler for this thread (takes precedence over AgentOptions). */
  userInputHandler?: (question: string) => Promise<string>;
}

export interface ThreadConfig {
  provider: AIProvider;
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
  /** Truncate individual tool results exceeding this character count. Default: 100000. */
  maxResultChars?: number;
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
  /** Default structured output format for all runs on this thread. */
  outputFormat?: OutputFormat;
  /** Default structured output mode for all runs on this thread. */
  structuredOutputMode?: "alongside_tools" | "final_response";
  /** When true, assert normalization invariants after every API message preparation. */
  debug?: boolean;
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
  private querySource: string | undefined;
  private resumeRequested = false;
  private fileStateCache: FileStateCache | null = null;
  private contentReplacementState: ContentReplacementState;
  private denialTracker: DenialTracker | null = null;
  /** Tracks file paths read by ReadFile for post-compact reinjection. */
  private recentlyReadFiles: Map<string, string> = new Map();

  constructor(config: ThreadConfig, opts?: ThreadOptions) {
    this.config = config;
    this.sessionId = opts?.sessionId ?? generateUUID();
    this.cwd = opts?.cwd ?? "/";
    this.model = opts?.model ?? config.model ?? "gpt-5.4";
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
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    if (opts?.signal) {
      if (opts.signal.aborted) {
        this.abortController.abort();
      } else {
        const localController = this.abortController;
        opts.signal.addEventListener("abort", () => localController.abort(), { once: true });
      }
    }
    const signal = this.abortController.signal;
    this.querySource = "main";

    const interactionSpan = this.tracer.startSpan("noumen.interaction", {
      attributes: {
        "session.id": this.sessionId,
        "model": this.model,
        "prompt.length": prompt.length,
      },
    });
    const interactionStart = Date.now();
    yield { type: "span_start", name: "noumen.interaction", spanId: this.sessionId };

    const isResumeRun = this.resumeRequested;

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

          if (this.config.toolResultStorage?.enabled && this.config.fs) {
            const storageResult = await enforceToolResultStorageBudget(
              this.messages,
              this.config.toolResultStorage,
              this.config.fs,
              this.sessionId,
              this.contentReplacementState,
            );
            this.messages = storageResult.messages;
            this.contentReplacementState = storageResult.state;
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

      // --- SessionStart hook ---
      await runNotificationHooks(this.hooks, "SessionStart", {
        event: "SessionStart",
        sessionId: this.sessionId,
        prompt,
        isResume: isResumeRun,
      } as import("./hooks/types.js").SessionStartHookInput);

      const allSkills = this.config.skills ?? [];
      let systemPrompt = await this.buildCurrentSystemPromptAsync(allSkills);

      // Structured output configuration: RunOptions override ThreadConfig defaults
      const runOutputFormat = opts?.outputFormat ?? this.config.outputFormat;
      const runOutputMode = opts?.structuredOutputMode ?? this.config.structuredOutputMode ?? "alongside_tools";
      const isFinalResponseMode = runOutputFormat?.type === "json_schema" && runOutputMode === "final_response";

      if (isFinalResponseMode) {
        const soTool = createStructuredOutputTool(runOutputFormat);
        if (!this.toolRegistry.get(STRUCTURED_OUTPUT_TOOL_NAME)) {
          this.toolRegistry.register(soTool);
        }
        systemPrompt += "\n\nWhen you have gathered all necessary information and are ready to give your final answer, call the StructuredOutput tool with your response data.";
      }

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
        signal,
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
        notifyHook: this.hooks.length > 0
          ? (event, input) => runNotificationHooks(this.hooks, event as import("./hooks/types.js").HookEvent, input as import("./hooks/types.js").HookInput)
          : undefined,
      };

      const turnUsage: ChatCompletionUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        thinking_tokens: 0,
      };
      const MAX_CONSECUTIVE_MALFORMED = 5;
      let callCount = 0;
      let consecutiveMalformedIterations = 0;
      let preventContinuation = false;
      let outputTokenRecoveryAttempts = 0;
      const hooks = this.hooks;

      const useStreamingExec = this.config.streamingToolExecution ?? false;
      const retryConfig = this.config.retry;
      let currentMaxTokens = this.config.maxTokens;

      const execCtx: ToolExecutionContext = {
        registry: this.toolRegistry,
        toolCtx,
        permCtx: this.permissionContext,
        permHandler: this.permissionHandler,
        denialTracker: this.denialTracker,
        hooks,
        sessionId: this.sessionId,
        tracer: this.tracer,
        parentSpan: interactionSpan,
        buildPermissionOpts: () => this.buildPermissionOpts(),
        maxResultChars: this.config.maxResultChars ?? 100_000,
      };

      this.microcompactTokensFreed = 0;
      this.hasAttemptedReactiveCompact = false;

      while (!signal.aborted) {
        // --- Pre-call compaction pipeline (disk spill, microcompact, budget, normalize) ---
        const prepResult = await prepareMessagesForApi(this.messages, {
          toolResultStorage: this.config.toolResultStorage,
          microcompact: this.config.microcompact,
          toolResultBudget: this.config.toolResultBudget,
          fs: this.config.fs,
          sessionId: this.sessionId,
          debug: this.config.debug,
        }, {
          contentReplacementState: this.contentReplacementState,
          budgetState: this.budgetState,
          microcompactTokensFreed: this.microcompactTokensFreed,
        });
        this.messages = prepResult.canonicalMessages;
        this.contentReplacementState = prepResult.state.contentReplacementState;
        this.budgetState = prepResult.state.budgetState;
        this.microcompactTokensFreed = prepResult.state.microcompactTokensFreed;
        let messagesForApi = prepResult.messagesForApi;
        for (const evt of prepResult.events) yield evt;

        // --- Proactive auto-compact (inside loop, before each API call) ---
        const loopAutoCompactConfig =
          this.config.autoCompact ?? createAutoCompactConfig({ model: this.model });
        const compactStep = await tryAutoCompactStep(
          this.messages, loopAutoCompactConfig, this.config.provider, this.model,
          {
            lastUsage: this.lastUsage,
            anchorMessageIndex: this.anchorMessageIndex,
            microcompactTokensFreed: this.microcompactTokensFreed,
            querySource: this.querySource,
            autoCompactTracking: this.autoCompactTracking,
            recentlyReadFiles: this.recentlyReadFiles,
            signal,
          },
          hooks, this.sessionId, this.storage,
        );
        for (const evt of compactStep.events) yield evt;
        if (compactStep.compacted) {
          this.messages = compactStep.messages!;
          this.recentlyReadFiles.clear();
          this.lastUsage = undefined;
          this.anchorMessageIndex = undefined;
          this.microcompactTokensFreed = 0;
          this.budgetState = createBudgetState();
          this.contentReplacementState = createContentReplacementState();
          this.fileStateCache?.clear();
          this.denialTracker?.reset();
          continue;
        }
        if (compactStep.events.length > 0 && !compactStep.compacted) {
          continue;
        }

        // --- TurnStart notification ---
        await runNotificationHooks(hooks, "TurnStart", {
          event: "TurnStart",
          sessionId: this.sessionId,
          messages: this.messages,
        });

        const accumulator = createAccumulator();

        let streamingExec: StreamingToolExecutor | null = null;
        const streamingResults: StreamingExecResult[] = [];

        if (useStreamingExec) {
          streamingExec = new StreamingToolExecutor(
            (name) => this.toolRegistry.get(name),
            this.buildStreamingExecutorFn(execCtx),
            signal,
          );
        }

        const sortedToolDefs = this.config.promptCachingEnabled
          ? sortToolDefinitionsForCache(toolDefs, this.config.mcpToolNames)
          : toolDefs;

        const chatParams = {
          model: this.model,
          messages: messagesForApi,
          tools: sortedToolDefs,
          system: systemPrompt,
          max_tokens: currentMaxTokens,
          thinking: this.config.thinking,
          skipCacheWrite: this.config.skipCacheWrite,
          signal,
          ...(runOutputFormat && !isFinalResponseMode ? { outputFormat: runOutputFormat } : {}),
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
              return this.config.provider.chat(params);
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
            if (event.type === "model_switch") {
              const sw = event as { type: "model_switch"; from: string; to: string };
              this.model = sw.to;
              stripThinkingSignatures(this.messages);
              resetAccumulator(accumulator);
              if (streamingExec) {
                streamingExec.discard();
                streamingExec = new StreamingToolExecutor(
                  (name) => this.toolRegistry.get(name),
                  this.buildStreamingExecutorFn(execCtx),
                  signal,
                );
              }
              streamingResults.length = 0;
              if (hooks.length > 0) {
                await runNotificationHooks(hooks, "ModelSwitch", {
                  event: "ModelSwitch",
                  sessionId: this.sessionId,
                  previousModel: sw.from,
                  newModel: sw.to,
                } as import("./hooks/types.js").ModelSwitchHookInput);
              }
            }
            if (event.type === "retry_attempt" && hooks.length > 0) {
              const re = event as { attempt: number; maxRetries: number; delayMs: number; error: Error };
              await runNotificationHooks(hooks, "RetryAttempt", {
                event: "RetryAttempt",
                sessionId: this.sessionId,
                attempt: re.attempt,
                maxAttempts: re.maxRetries,
                error: re.error.message,
                delay: re.delayMs,
              } as import("./hooks/types.js").RetryAttemptHookInput);
            }
            yield event;
            retryResult = await retryGen.next();
          }

          stream = retryResult.value;
        } else {
          stream = this.config.provider.chat(chatParams);
        }
        } catch (providerErr) {
          // Collect any already-completed streaming results before discarding.
          // These tools ran successfully with real side effects so their results
          // must be preserved rather than replaced with fabricated errors.
          const completedBeforeError: StreamingExecResult[] = [];
          if (streamingExec) {
            for (const result of streamingExec.getCompletedResults()) {
              completedBeforeError.push(result);
            }
            streamingExec.discard();
          }

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

            const recovery = await tryReactiveCompactRecoveryFn({
              provider: this.config.provider,
              model: this.model,
              messages: this.messages,
              storage: this.storage,
              sessionId: this.sessionId,
              signal,
              hooks,
            });
            for (const evt of recovery.events) yield evt;
            if (recovery.recovered) {
              this.messages = recovery.messages!;
              this.lastUsage = undefined;
              this.anchorMessageIndex = undefined;
              this.microcompactTokensFreed = 0;
              this.budgetState = createBudgetState();
              this.contentReplacementState = createContentReplacementState();
              this.fileStateCache?.clear();
              this.denialTracker?.reset();
              recordAutoCompactSuccess(this.autoCompactTracking);
              continue;
            }
          }

          const errorReason = `Provider error: ${providerErr instanceof Error ? providerErr.message : String(providerErr)}`;
          const partial = buildPartialResults({
            accumulatedToolCalls: accumulator.toolCalls,
            accumulatedContent: accumulator.content,
            completedStreamingResults: completedBeforeError,
            reason: errorReason,
            existingMessages: this.messages,
          });
          for (const msg of partial.messages) {
            this.messages.push(msg);
            await this.storage.appendMessage(this.sessionId, msg);
          }

          providerSpan.setStatus(SpanStatusCode.ERROR, providerErr instanceof Error ? providerErr.message : String(providerErr));
          providerSpan.end();
          yield { type: "span_end", name: "noumen.provider.chat", spanId: providerSpanId, durationMs: Date.now() - providerStart, error: String(providerErr) };

          throw providerErr;
        }

        const apiStartTime = Date.now();

        try {
        for await (const evt of consumeStream(stream, accumulator, streamingExec, streamingResults, signal)) {
          yield evt;
        }
        } catch (streamErr) {
          const streamCompletedResults: StreamingExecResult[] = [];
          if (streamingExec) {
            for (const result of streamingExec.getCompletedResults()) {
              streamCompletedResults.push(result);
            }
            streamingExec.discard();
          }
          const streamErrReason = `Stream error: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`;
          const partial = buildPartialResults({
            accumulatedToolCalls: accumulator.toolCalls,
            accumulatedContent: accumulator.content,
            completedStreamingResults: streamCompletedResults,
            reason: streamErrReason,
          });
          for (const msg of partial.messages) {
            this.messages.push(msg);
            await this.storage.appendMessage(this.sessionId, msg);
          }
          throw streamErr;
        }

        const apiDurationMs = Date.now() - apiStartTime;

        // Check abort before processing finish reason — no events after abort
        if (signal.aborted) {
          providerSpan.setStatus(SpanStatusCode.OK);
          providerSpan.end();
          yield { type: "span_end", name: "noumen.provider.chat", spanId: providerSpanId, durationMs: Date.now() - providerStart };

          // Discard stops scheduling new tools; getRemainingResults() then
          // yields completed results and synthesizes errors for the rest.
          if (streamingExec) {
            streamingExec.discard();
            for await (const result of streamingExec.getRemainingResults()) {
              streamingResults.push(result);
            }
          }

          const abortPartial = buildPartialResults({
            accumulatedToolCalls: accumulator.toolCalls,
            accumulatedContent: accumulator.content,
            completedStreamingResults: streamingResults,
            reason: "abort",
            includeInterruptionTag: false,
          });
          for (const msg of abortPartial.messages) {
            this.messages.push(msg);
            await this.storage.appendMessage(this.sessionId, msg).catch((err) => {
              console.warn("[noumen/thread] Failed to persist abort message:", err);
            });
          }

          const interruptionMsg: ChatMessage = {
            role: "user",
            content: "[Session interrupted by user. Continue from where you left off if resumed.]",
          };
          this.messages.push(interruptionMsg);
          await this.storage.appendMessage(this.sessionId, interruptionMsg).catch(() => {});

          break;
        }

        const frResult = handleFinishReason(
          accumulator, streamingExec, streamingResults,
          currentMaxTokens, outputTokenRecoveryAttempts, signal,
        );
        for (const evt of frResult.events) yield evt;
        for (const msg of frResult.messagesToPersist) {
          this.messages.push(msg);
          await this.storage.appendMessage(this.sessionId, msg).catch(() => {});
        }
        if (frResult.escalateMaxTokens !== undefined) currentMaxTokens = frResult.escalateMaxTokens;
        if (frResult.shouldContinue) {
          outputTokenRecoveryAttempts++;
          streamingExec?.discard();
          accumulator.toolCalls.clear();
          continue;
        }
        if (frResult.preventContinuation) preventContinuation = true;

        callCount++;
        const usageResult = accumulateUsage({
          usage: accumulator.usage,
          turnUsage,
          model: this.model,
          messagesLength: this.messages.length,
        });
        for (const evt of usageResult.events) yield evt;
        if (usageResult.lastUsage) {
          this.lastUsage = usageResult.lastUsage;
          this.anchorMessageIndex = usageResult.anchorMessageIndex!;
          this.microcompactTokensFreed = 0;

          if (this.config.costTracker) {
            const summary = this.config.costTracker.addUsage(
              this.model,
              usageResult.lastUsage,
              apiDurationMs,
            );
            yield { type: "cost_update", summary };

            await this.storage.appendMetadata(
              this.sessionId,
              "costState",
              this.config.costTracker.getState(),
            ).catch(() => {});
          }

          providerSpan.setAttribute("tokens.input", usageResult.lastUsage.prompt_tokens);
          providerSpan.setAttribute("tokens.output", usageResult.lastUsage.completion_tokens);
        }

        if (this.config.promptCachingEnabled) {
          saveCacheSafeParams(
            createCacheSafeParams({
              systemPrompt,
              model: this.model,
              tools: sortedToolDefs,
              thinking: this.config.thinking,
            }),
            this.sessionId,
          );
        }

        providerSpan.setStatus(SpanStatusCode.OK);
        providerSpan.end();
        yield { type: "span_end", name: "noumen.provider.chat", spanId: providerSpanId, durationMs: Date.now() - providerStart };

        const { valid: toolCalls, malformed: malformedToolCalls } = separateToolCalls(accumulator, !!streamingExec);

        const assistantMsg = buildAssistantMessage({
          acc: accumulator,
          validToolCalls: toolCalls,
          malformedToolCalls,
          turnId: `${this.sessionId}:${callCount}`,
        });
        this.messages.push(assistantMsg);
        await this.storage.appendMessage(this.sessionId, assistantMsg);

        const malformedResult = generateMalformedToolResults(malformedToolCalls);
        for (const msg of malformedResult.messages) {
          this.messages.push(msg);
          await this.storage.appendMessage(this.sessionId, msg);
        }
        for (const evt of malformedResult.events) yield evt;

        // When only malformed calls exist, continue the loop to give the
        // model another chance without entering the tool execution path.
        if (toolCalls.length === 0 && malformedToolCalls.length > 0) {
          consecutiveMalformedIterations++;
          if (consecutiveMalformedIterations >= MAX_CONSECUTIVE_MALFORMED) {
            yield { type: "error", error: new Error(`Exceeded ${MAX_CONSECUTIVE_MALFORMED} consecutive malformed tool call attempts`) };
            break;
          }
          if (opts?.maxTurns !== undefined && callCount >= opts.maxTurns) {
            await runNotificationHooks(hooks, "TurnEnd", {
              event: "TurnEnd",
              sessionId: this.sessionId,
            });
            yield { type: "turn_complete", usage: turnUsage, model: this.model, callCount };
            yield { type: "max_turns_reached", maxTurns: opts.maxTurns, turnCount: callCount };
            break;
          }
          await runNotificationHooks(hooks, "TurnEnd", {
            event: "TurnEnd",
            sessionId: this.sessionId,
          });
          continue;
        }

        if (toolCalls.length > 0) {
          consecutiveMalformedIterations = 0;

          const stepResult = await executeToolsStep(
            toolCalls,
            streamingExec,
            streamingResults,
            execCtx,
            this.toolRegistry,
            this.sessionId,
            this.messages,
            this.recentlyReadFiles,
            this.storage,
            (id, name, content) => this.maybeSpillToolResult(id, name, content),
          );
          for (const evt of stepResult.events) yield evt;
          if (stepResult.preventContinuation) preventContinuation = true;

          if (stepResult.spilledRecords.length > 0) {
            await this.storage.appendContentReplacement(this.sessionId, stepResult.spilledRecords);
          }

          const touchedFilePaths = stepResult.touchedFilePaths;

          if (signal.aborted) {
            const interruptionMsg: ChatMessage = {
              role: "user",
              content: "[Session interrupted by user. Continue from where you left off if resumed.]",
            };
            this.messages.push(interruptionMsg);
            await this.storage.appendMessage(this.sessionId, interruptionMsg).catch(() => {});
            break;
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

          // Detect StructuredOutput tool call in final_response mode
          if (isFinalResponseMode) {
            for (const tc of toolCalls) {
              if (tc.function.name === STRUCTURED_OUTPUT_TOOL_NAME) {
                try {
                  const parsed = JSON.parse(tc.function.arguments);
                  yield {
                    type: "structured_output",
                    data: parsed.data ?? parsed,
                    schema: runOutputFormat,
                  };
                } catch {
                  yield {
                    type: "structured_output",
                    data: tc.function.arguments,
                    schema: runOutputFormat,
                  };
                }
                preventContinuation = true;
                break;
              }
            }
          }

          if (preventContinuation) {
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

          if (opts?.maxTurns !== undefined && callCount >= opts.maxTurns) {
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
            yield { type: "max_turns_reached", maxTurns: opts.maxTurns, turnCount: callCount };
            break;
          }
          this.hasAttemptedReactiveCompact = false;
          await runNotificationHooks(hooks, "TurnEnd", {
            event: "TurnEnd",
            sessionId: this.sessionId,
          });
          continue;
        }

        // For alongside_tools mode, emit structured_output when the model produces text
        const textContent = accumulator.content.join("");
        if (runOutputFormat && !isFinalResponseMode && textContent) {
          try {
            const parsed = JSON.parse(textContent);
            yield {
              type: "structured_output",
              data: parsed,
              schema: runOutputFormat,
            };
          } catch {
            // Model text wasn't valid JSON — still emit message_complete below
          }
        }

        yield { type: "message_complete", message: assistantMsg };

        this.hasAttemptedReactiveCompact = false;
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

        // Persist cost state so it survives resume
        if (this.config.costTracker) {
          await this.storage.appendMetadata(
            this.sessionId,
            "costState",
            this.config.costTracker.getState(),
          );
        }

        break;
      }

      // --- Memory extraction (skip on abort) ---
      if (signal.aborted) {
        await runNotificationHooks(hooks, "TurnEnd", {
          event: "TurnEnd",
          sessionId: this.sessionId,
        });
        yield { type: "turn_complete", usage: turnUsage, model: this.model, callCount };
        interactionSpan.setStatus(SpanStatusCode.OK);
        interactionSpan.end();
        yield { type: "span_end", name: "noumen.interaction", spanId: this.sessionId, durationMs: Date.now() - interactionStart };
        await runNotificationHooks(this.hooks, "SessionEnd", {
          event: "SessionEnd",
          sessionId: this.sessionId,
          reason: "abort",
        } as import("./hooks/types.js").SessionEndHookInput);
        return;
      }
      const memCfg = this.config.memory;
      if (memCfg && memCfg.autoExtract && memCfg.provider) {
        try {
          const extractResult = await extractMemories(
            this.config.provider,
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
            const allEntries = [
              ...extractResult.created.map((e) => ({ type: "created", content: e.content })),
              ...extractResult.updated.map((e) => ({ type: "updated", content: e.content })),
              ...extractResult.deleted.map((id) => ({ type: "deleted", content: id })),
            ];
            await runNotificationHooks(this.hooks, "MemoryUpdate", {
              event: "MemoryUpdate",
              sessionId: this.sessionId,
              entries: allEntries,
            } as import("./hooks/types.js").MemoryUpdateHookInput);
          }
        } catch {
          // Memory extraction is best-effort; don't fail the turn.
        }
      }

      interactionSpan.setStatus(SpanStatusCode.OK);
      interactionSpan.end();
      yield { type: "span_end", name: "noumen.interaction", spanId: this.sessionId, durationMs: Date.now() - interactionStart };

      // Determine session end reason
      const endReason: "complete" | "abort" | "maxTurns" = signal.aborted
        ? "abort"
        : (opts?.maxTurns !== undefined && callCount >= opts.maxTurns)
          ? "maxTurns"
          : "complete";
      await runNotificationHooks(this.hooks, "SessionEnd", {
        event: "SessionEnd",
        sessionId: this.sessionId,
        reason: endReason,
      } as import("./hooks/types.js").SessionEndHookInput);
    } catch (err) {
      if (!signal.aborted) {
        const error = err instanceof Error ? err : new Error(String(err));

        // Synthesize missing tool results so the conversation stays API-valid.
        // If the last message is an assistant with tool_calls that lack results,
        // inject error results before yielding the error event.
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).tool_calls?.length) {
          const syntheticResults = generateMissingToolResults(
            lastMsg as AssistantMessage,
            this.messages,
            `Session error: ${error.message}`,
          );
          for (const sr of syntheticResults) {
            this.messages.push(sr);
            await this.storage.appendMessage(this.sessionId, sr);
          }
        }

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

      await runNotificationHooks(this.hooks, "SessionEnd", {
        event: "SessionEnd",
        sessionId: this.sessionId,
        reason: signal.aborted ? "abort" : "error",
      } as import("./hooks/types.js").SessionEndHookInput);
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
    execCtx: ToolExecutionContext,
  ): import("./tools/streaming-executor.js").StreamingToolExecutorFn {
    return async (tc, parsedArgs, signal) => {
      const ctx = signal
        ? { ...execCtx, toolCtx: { ...execCtx.toolCtx, signal } }
        : execCtx;
      const pipelineResult = await executeToolCall(tc, parsedArgs, ctx);
      return {
        result: pipelineResult.result,
        permissionDenied: pipelineResult.permissionDenied,
        preventContinuation: pipelineResult.preventContinuation,
        events: pipelineResult.events,
      };
    };
  }

  private buildPermissionOpts(): ResolvePermissionOptions | undefined {
    const autoMode = this.config.permissions?.autoMode;
    if (!autoMode) return undefined;
    const tail = this.messages.slice(-10);
    return {
      provider: this.config.provider,
      model: this.model,
      recentMessages: tail,
      autoModeConfig: autoMode,
      denialTracker: this.denialTracker ?? undefined,
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
      this.config.provider,
      this.model,
      this.messages,
      this.storage,
      this.sessionId,
      {
        customInstructions: opts?.instructions,
        recentlyReadFiles: this.recentlyReadFiles.size > 0 ? this.recentlyReadFiles : undefined,
      },
    );
    this.recentlyReadFiles.clear();
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
        const afterBoundary = entries.slice(i + 1);
        const hasSummaryOrMessage = afterBoundary.some(
          (e) => e.type === "summary" || e.type === "message",
        );
        if (hasSummaryOrMessage) {
          lastBoundaryIdx = i;
          break;
        }
      }
    }

    const activeEntries = entries.slice(lastBoundaryIdx + 1);
    const result = applySnipRemovals(activeEntries);
    this.messages = result.messages;
  }

  setModel(model: string): void {
    const prev = this.model;
    this.model = model;
    if (prev !== model && this.hooks.length > 0) {
      runNotificationHooks(this.hooks, "ModelSwitch", {
        event: "ModelSwitch",
        sessionId: this.sessionId,
        previousModel: prev,
        newModel: model,
      } as import("./hooks/types.js").ModelSwitchHookInput).catch(() => {});
    }
  }

  setProvider(provider: AIProvider, model?: string): void {
    const prev = this.model;
    this.config.provider = provider;
    if (model) this.model = model;
    if (model && prev !== model && this.hooks.length > 0) {
      runNotificationHooks(this.hooks, "ModelSwitch", {
        event: "ModelSwitch",
        sessionId: this.sessionId,
        previousModel: prev,
        newModel: model,
      } as import("./hooks/types.js").ModelSwitchHookInput).catch(() => {});
    }
  }

  getModel(): string {
    return this.model;
  }

  getCwd(): string {
    return this.cwd;
  }

  abort(): void {
    this.abortController?.abort();
  }
}

/**
 * Remove thinking_signature and redacted_thinking_data from assistant
 * messages. These fields are model-bound — replaying them to a different
 * model (after a fallback) causes a 400 error.
 */
function stripThinkingSignatures(messages: ChatMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const asst = msg as AssistantMessage;
    if (asst.thinking_signature) delete asst.thinking_signature;
    if (asst.redacted_thinking_data) delete asst.redacted_thinking_data;
  }
}
