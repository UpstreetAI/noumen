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
import { filterActiveContextFiles } from "./context/loader.js";
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
import type { FileCheckpointManager } from "./checkpoint/manager.js";
import { restoreSession } from "./session/resume.js";
import { generateMissingToolResults } from "./session/recovery.js";
import {
  runNotificationHooks,
} from "./hooks/runner.js";
import { ToolRegistry } from "./tools/registry.js";
import {
  executeToolCall,
  type ToolExecutionContext,
} from "./tools/execution-pipeline.js";
import { SessionStorage } from "./session/storage.js";
import { buildSystemPrompt } from "./prompt/system.js";
import { compactConversation } from "./compact/compact.js";
import {
  createAutoCompactConfig,
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
import type { SnipConfig } from "./compact/history-snip.js";
import { FileStateCache } from "./file-state/cache.js";
import type { FileStateCacheConfig } from "./file-state/types.js";
import { generateUUID } from "./utils/uuid.js";
import { getActiveSkills } from "./skills/activation.js";
import { createSkillTool } from "./tools/skill.js";
import type { ResolvePermissionOptions } from "./permissions/pipeline.js";
import { DenialTracker } from "./permissions/denial-tracking.js";
import {
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "./tools/structured-output.js";
import { initializeSession } from "./pipeline/initialize-session.js";
import { executeProviderRound, stripThinkingSignatures } from "./pipeline/provider-round.js";
import { postToolStep } from "./pipeline/post-tool-step.js";
import { finalizeLoopExit, finalizeTurn } from "./pipeline/finalize-turn.js";

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
  /** Dot-directory resolver — threaded to tools that write under dotdirs (e.g. worktrees). */
  dotDirResolver?: import("./config/dot-dirs.js").DotDirResolver;
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
    const resolvedModel =
      opts?.model ?? config.model ?? config.provider.defaultModel;
    if (!resolvedModel) {
      throw new Error(
        "Thread: no model resolved. Pass `model` to Thread / Agent / preset " +
          "options, set `config.model`, or provide a provider with a " +
          "`defaultModel` (built-in providers expose one automatically).",
      );
    }
    this.model = resolvedModel;
    this.storage = new SessionStorage(config.fs, config.sessionDir);

    if (config.permissions) {
      this.permissionContext = {
        mode: config.permissions.mode ?? "default",
        rules: [...(config.permissions.rules ?? [])],
        workingDirectories: [...(config.permissions.workingDirectories ?? [])],
        dotDirNames: config.dotDirResolver?.config.names,
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
      const initResult = await initializeSession({
        storage: this.storage,
        sessionId: this.sessionId,
        hooks: this.hooks,
        prompt,
        resumeRequested: this.resumeRequested,
        loaded: this.loaded,
        messages: this.messages,
        contentReplacementState: this.contentReplacementState,
        isResumeRun,
        checkpointManager: this.config.checkpointManager,
        costTracker: this.config.costTracker,
        toolResultStorage: this.config.toolResultStorage,
        fs: this.config.fs,
      });
      this.messages = initResult.messages;
      this.contentReplacementState = initResult.contentReplacementState;
      this.loaded = initResult.loaded;
      this.resumeRequested = initResult.resumeRequested;
      const turnMessageId = initResult.turnMessageId;
      for (const evt of initResult.events) yield evt;

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
        dotDirResolver: this.config.dotDirResolver,
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

        // --- Provider round ---
        const roundGen = executeProviderRound({
          messages: this.messages,
          storage: this.storage,
          sessionId: this.sessionId,
          provider: this.config.provider,
          model: this.model,
          messagesForApi,
          systemPrompt,
          toolDefs,
          maxTokens: currentMaxTokens,
          thinking: this.config.thinking,
          retryConfig,
          promptCachingEnabled: this.config.promptCachingEnabled ?? false,
          skipCacheWrite: this.config.skipCacheWrite,
          outputFormat: runOutputFormat,
          isFinalResponseMode,
          useStreamingExec,
          signal,
          tracer: this.tracer,
          parentSpan: interactionSpan,
          hooks,
          toolRegistryLookup: (name) => this.toolRegistry.get(name),
          buildStreamingExecutorFn: this.buildStreamingExecutorFn(execCtx),
          reactiveCompact: this.config.reactiveCompact,
          hasAttemptedReactiveCompact: this.hasAttemptedReactiveCompact,
          autoCompactTracking: this.autoCompactTracking,
          mcpToolNames: this.config.mcpToolNames,
          costTracker: this.config.costTracker,
          turnUsage,
          callCount,
          consecutiveMalformedIterations,
          preventContinuation,
          currentMaxTokens,
          outputTokenRecoveryAttempts,
          maxTurns: opts?.maxTurns,
        });
        let roundStep = await roundGen.next();
        while (!roundStep.done) {
          yield roundStep.value;
          roundStep = await roundGen.next();
        }
        const roundResult = roundStep.value;

        // Apply state updates from the provider round
        this.model = roundResult.model;
        callCount = roundResult.callCount;
        consecutiveMalformedIterations = roundResult.consecutiveMalformedIterations;
        preventContinuation = roundResult.preventContinuation;
        currentMaxTokens = roundResult.currentMaxTokens;
        outputTokenRecoveryAttempts = roundResult.outputTokenRecoveryAttempts;
        this.hasAttemptedReactiveCompact = roundResult.hasAttemptedReactiveCompact;
        if (roundResult.lastUsage) {
          this.lastUsage = roundResult.lastUsage;
          this.anchorMessageIndex = roundResult.anchorMessageIndex;
          this.microcompactTokensFreed = roundResult.microcompactTokensFreed;
        }

        if (roundResult.compactRecovered && roundResult.recoveredMessages) {
          this.messages = roundResult.recoveredMessages;
          this.lastUsage = undefined;
          this.anchorMessageIndex = undefined;
          this.microcompactTokensFreed = 0;
          this.budgetState = createBudgetState();
          this.contentReplacementState = createContentReplacementState();
          this.fileStateCache?.clear();
          this.denialTracker?.reset();
        }

        if (roundResult.shouldContinueOuterLoop) continue;
        if (roundResult.shouldBreakOuterLoop) break;

        const { toolCalls, malformedToolCalls, assistantMsg: assistantMsgOrNull, accumulator, streamingExec, streamingResults } = roundResult;
        const assistantMsg = assistantMsgOrNull!;

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

          const postResult = await postToolStep({
            touchedFilePaths: stepResult.touchedFilePaths,
            toolCalls,
            spilledRecords: stepResult.spilledRecords,
            signal,
            sessionId: this.sessionId,
            storage: this.storage,
            messages: this.messages,
            hooks,
            allSkills,
            activatedSkills: this.activatedSkills,
            projectContext: this.config.projectContext,
            activatedContextRules: this.activatedContextRules,
            cwd: this.cwd,
            isFinalResponseMode,
            outputFormat: runOutputFormat,
            maxTurns: opts?.maxTurns,
            callCount,
            preventContinuation,
            turnUsage,
            model: this.model,
            toolSearchEnabled: this.config.toolSearchEnabled ?? false,
            getActiveToolDefinitions: () => this.toolRegistry.getActiveToolDefinitions(),
            buildSystemPrompt: () => this.buildCurrentSystemPromptAsync(allSkills),
          });
          for (const evt of postResult.events) yield evt;
          preventContinuation = postResult.preventContinuation;
          if (postResult.systemPrompt) systemPrompt = postResult.systemPrompt;
          if (postResult.toolDefs) toolDefs = postResult.toolDefs;
          if (postResult.hasAttemptedReactiveCompactReset) this.hasAttemptedReactiveCompact = false;
          if (postResult.shouldBreak) break;
          if (postResult.shouldContinue) continue;
        }

        // No tool calls — finalize the loop iteration
        this.hasAttemptedReactiveCompact = false;
        const loopExitResult = await finalizeLoopExit({
          accumulator,
          assistantMsg,
          outputFormat: runOutputFormat,
          isFinalResponseMode,
          turnUsage,
          model: this.model,
          callCount,
          sessionId: this.sessionId,
          costTracker: this.config.costTracker,
          hooks: this.hooks,
          storage: this.storage,
        });
        for (const evt of loopExitResult.events) yield evt;
        break;
      }

      // --- Post-loop teardown: memory extraction + span close + SessionEnd ---
      const teardownResult = await finalizeTurn({
        signal,
        memoryConfig: this.config.memory,
        provider: this.config.provider,
        model: this.model,
        messages: this.messages,
        sessionId: this.sessionId,
        callCount,
        maxTurns: opts?.maxTurns,
        hooks: this.hooks,
        interactionSpan,
        interactionStart,
      });
      for (const evt of teardownResult.events) yield evt;
      if (teardownResult.earlyReturn) return;
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
