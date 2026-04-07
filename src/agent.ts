import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import type { AIProvider, OutputFormat, ChatCompletionUsage } from "./providers/types.js";
import type { ProviderName } from "./providers/resolve.js";
import type { VirtualFs } from "./virtual/fs.js";
import type { VirtualComputer } from "./virtual/computer.js";
import { UnsandboxedLocal, type Sandbox } from "./virtual/sandbox.js";
import type { StreamEvent, RunOptions, ToolResult, ContentPart } from "./session/types.js";
import type { SkillDefinition } from "./skills/types.js";
import type { Tool, SubagentConfig, SubagentRun } from "./tools/types.js";
import type { CheckpointConfig } from "./checkpoint/types.js";
import { FileCheckpointManager } from "./checkpoint/manager.js";
import type { CacheControlConfig } from "./providers/cache.js";
import { agentTool } from "./tools/agent.js";
import { createWebSearchTool, type WebSearchConfig } from "./tools/web-search.js";
import { createToolSearchTool } from "./tools/tool-search.js";
import { taskCreateTool } from "./tools/task-create.js";
import { taskListTool } from "./tools/task-list.js";
import { taskGetTool } from "./tools/task-get.js";
import { taskUpdateTool } from "./tools/task-update.js";
import { enterPlanModeTool, exitPlanModeTool } from "./tools/plan-mode.js";
import { enterWorktreeTool, exitWorktreeTool } from "./tools/worktree.js";
import type { LspServerManager } from "./lsp/manager.js";
import type { LspServerConfig } from "./lsp/types.js";
import type { SessionInfo } from "./session/types.js";
import type { McpServerConfig } from "./mcp/types.js";
import type { TokenStorage } from "./mcp/auth/types.js";
import type { PermissionConfig } from "./permissions/types.js";
import type { HookDefinition } from "./hooks/types.js";
import type { ThinkingConfig } from "./thinking/types.js";
import type { RetryConfig } from "./retry/types.js";
import type { ModelPricing } from "./cost/types.js";
import type { TracingConfig, Tracer } from "./tracing/types.js";
import type { MemoryConfig, MemoryProvider } from "./memory/types.js";
import type { MicrocompactConfig } from "./compact/microcompact.js";
import type { ToolResultBudgetConfig } from "./compact/tool-result-budget.js";
import type { ReactiveCompactConfig } from "./compact/reactive-compact.js";
import type { FileStateCacheConfig } from "./file-state/types.js";
import type { ToolResultStorageConfig } from "./compact/tool-result-storage.js";
import type { SnipConfig } from "./compact/history-snip.js";
import { CostTracker } from "./cost/tracker.js";
import type { McpClientManager } from "./mcp/client.js";
import { SessionStorage } from "./session/storage.js";
import { TaskStore } from "./tasks/store.js";
import { Thread, type ThreadOptions } from "./thread.js";
import { createAutoCompactConfig } from "./compact/auto-compact.js";
import { buildUserContext } from "./prompt/context.js";
import { DEFAULT_RETRY_CONFIG } from "./retry/types.js";
import type { ContextFile, ProjectContextConfig } from "./context/types.js";
import { loadProjectContext } from "./context/loader.js";
import {
  checkProviderHealth,
  checkVirtualFs,
  checkVirtualComputer,
  checkSandboxRuntime,
  summarizeMcpStatus,
  summarizeLspStatus,
} from "./diagnostics.js";
import { resolveAgentConfig } from "./agent-config.js";

export interface DiagnoseCheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  warning?: string;
}

export interface DiagnoseResult {
  overall: boolean;
  provider: DiagnoseCheckResult & { model?: string };
  sandbox: { fs: DiagnoseCheckResult; computer: DiagnoseCheckResult };
  sandboxRuntime: DiagnoseCheckResult & { platform?: string };
  mcp: Record<string, DiagnoseCheckResult & { status?: string; toolCount?: number }>;
  lsp: Record<string, DiagnoseCheckResult & { state?: string }>;
  timestamp: string;
}

export interface AgentOptions {
  /**
   * AI provider — either an `AIProvider` instance or a provider name string.
   * When a string is passed (e.g. `"openai"`), the provider is resolved
   * lazily using env-var auto-detection on the first call to `run()`,
   * `createThread()`, or `init()`.
   */
  provider: AIProvider | ProviderName;

  /**
   * Working directory. When set without an explicit `sandbox`, an
   * `UnsandboxedLocal({ cwd })` is created automatically.
   */
  cwd?: string;

  /**
   * Bundled sandbox providing both filesystem and shell execution.
   * Use `LocalSandbox()` for OS-level sandboxing (requires
   * `@anthropic-ai/sandbox-runtime`), `UnsandboxedLocal()` for raw host
   * access, `SpritesSandbox()` for isolated remote containers, or pass
   * any `{ fs: VirtualFs; computer: VirtualComputer }` for custom sandboxes.
   *
   * Defaults to `UnsandboxedLocal({ cwd })` when omitted — the library
   * default is non-sandboxed for backward compatibility. The CLI defaults
   * to `LocalSandbox()` when sandbox-runtime is available.
   */
  sandbox?: Sandbox;

  options?: {
    sessionDir?: string;
    skills?: SkillDefinition[];
    skillsPaths?: string[];
    tools?: Tool[];
    mcpServers?: Record<string, McpServerConfig>;
    /** Token storage for MCP OAuth flows (defaults to in-memory). */
    mcpTokenStorage?: TokenStorage;
    /** Called when an MCP server requires OAuth and the user must visit a URL. */
    mcpOnAuthorizationUrl?: (url: string) => void | Promise<void>;
    systemPrompt?: string;
    model?: string;
    maxTokens?: number;
    autoCompact?: boolean;
    autoCompactThreshold?: number;
    microcompact?: MicrocompactConfig;
    toolResultBudget?: ToolResultBudgetConfig;
    reactiveCompact?: ReactiveCompactConfig;
    cwd?: string;
    permissions?: PermissionConfig;
    hooks?: HookDefinition[];
    enableSubagents?: boolean;
    enableTasks?: boolean;
    tasksDir?: string;
    enablePlanMode?: boolean;
    enableWorktrees?: boolean;
    lsp?: Record<string, LspServerConfig>;
    streamingToolExecution?: boolean;
    webSearch?: WebSearchConfig;
    userInputHandler?: (question: string) => Promise<string>;
    thinking?: ThinkingConfig;
    retry?: RetryConfig | boolean;
    costTracking?: {
      enabled: boolean;
      pricing?: Record<string, ModelPricing>;
    };
    tracing?: TracingConfig;
    memory?: MemoryConfig;
    /** Enable ToolSearch: deferred tools are hidden until the model discovers them. */
    toolSearch?: boolean;
    /** File checkpointing: snapshot files before edits for rollback. */
    checkpoint?: CheckpointConfig;
    /** Prompt caching: enable deterministic tool ordering and cache_control injection. */
    promptCaching?: CacheControlConfig;
    /** File state cache: track reads for read-before-edit enforcement. */
    fileStateCache?: FileStateCacheConfig;
    /** Disk-backed storage for oversized tool results. */
    toolResultStorage?: ToolResultStorageConfig;
    /** History snip: enable middle-range removal from conversation history. */
    historySnip?: SnipConfig;
    /** Project context loading (NOUMEN.md / CLAUDE.md). Pass true for defaults or a config object. */
    projectContext?: ProjectContextConfig | boolean;
    /** Default structured output format for all threads. */
    outputFormat?: OutputFormat;
    /** Default structured output mode for all threads. */
    structuredOutputMode?: "alongside_tools" | "final_response";
  };
}

export interface RunCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolUse?: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: ToolResult) => void;
  onError?: (error: Error) => void;
  onComplete?: (result: RunResult) => void;
}

export interface RunResult {
  text: string;
  toolCalls: number;
  usage: ChatCompletionUsage;
  sessionId: string;
}

export class Agent {
  private providerInput: AIProvider | ProviderName;
  private resolvedProvider: AIProvider | null = null;
  private fs: VirtualFs;
  private computer: VirtualComputer;
  private sandbox: import("./virtual/sandbox.js").Sandbox;
  private sessionDir: string;
  private skills: SkillDefinition[];
  private skillsPaths: string[];
  private tools: Tool[];
  private systemPrompt?: string;
  private model?: string;
  private maxTokens?: number;
  private autoCompactEnabled: boolean;
  private autoCompactThreshold?: number;
  private cwd: string;
  private storage: SessionStorage;
  private resolvedSkills: SkillDefinition[] | null = null;
  private mcpManager: McpClientManager | null = null;
  private mcpServerConfigs?: Record<string, McpServerConfig>;
  private mcpTokenStorage?: TokenStorage;
  private mcpOnAuthorizationUrl?: (url: string) => void | Promise<void>;
  private mcpTools: Tool[] = [];
  private mcpToolNames: Set<string> = new Set();
  private mcpAuthTools: Tool[] = [];
  private permissions?: PermissionConfig;
  private hooks: HookDefinition[];
  private enableSubagents: boolean;
  private enableTasks: boolean;
  private taskStore: TaskStore | null = null;
  private enablePlanMode: boolean;
  private enableWorktrees: boolean;
  private lspManager: LspServerManager | null = null;
  private lspConfigs?: Record<string, LspServerConfig>;
  private lspToolRef: Tool | null = null;
  private streamingToolExecution: boolean;
  private webSearchConfig?: WebSearchConfig;
  private userInputHandler?: (question: string) => Promise<string>;
  private thinkingConfig?: ThinkingConfig;
  private retryConfig?: RetryConfig;
  private costTracker: CostTracker | null = null;
  private tracer?: Tracer;
  private memoryProvider?: MemoryProvider;
  private memoryConfig?: MemoryConfig;
  private microcompactConfig?: MicrocompactConfig;
  private toolResultBudgetConfig?: ToolResultBudgetConfig;
  private reactiveCompactConfig?: ReactiveCompactConfig;
  private toolSearchEnabled: boolean;
  private projectContextConfig?: ProjectContextConfig;
  private resolvedProjectContext: ContextFile[] | null = null;
  private checkpointManager: FileCheckpointManager | null = null;
  private promptCachingConfig: CacheControlConfig | undefined;
  private fileStateCacheConfig: FileStateCacheConfig | undefined;
  private toolResultStorageConfig: ToolResultStorageConfig | undefined;
  private historySnipConfig: SnipConfig | undefined;
  private outputFormat: OutputFormat | undefined;
  private structuredOutputMode: "alongside_tools" | "final_response" | undefined;
  private providerPromise: Promise<AIProvider> | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(opts: AgentOptions) {
    this.providerInput = opts.provider;
    if (typeof opts.provider !== "string") {
      this.resolvedProvider = opts.provider;
    }

    const resolved = resolveAgentConfig({
      cwd: opts.cwd,
      optionsCwd: opts.options?.cwd,
      retry: opts.options?.retry,
      projectContext: opts.options?.projectContext,
      mcpServers: opts.options?.mcpServers,
      lsp: opts.options?.lsp,
    });

    const resolvedSandbox = opts.sandbox ?? UnsandboxedLocal({ cwd: resolved.effectiveCwd });

    this.sandbox = resolvedSandbox;
    this.fs = resolvedSandbox.fs;
    this.computer = resolvedSandbox.computer;
    this.sessionDir = opts.options?.sessionDir ?? ".noumen/sessions";
    this.skills = opts.options?.skills ?? [];
    this.skillsPaths = opts.options?.skillsPaths ?? [];
    this.tools = opts.options?.tools ?? [];
    this.systemPrompt = opts.options?.systemPrompt;
    this.model = opts.options?.model;
    this.maxTokens = opts.options?.maxTokens;
    this.autoCompactEnabled = opts.options?.autoCompact ?? true;
    this.autoCompactThreshold = opts.options?.autoCompactThreshold;
    this.cwd = resolved.effectiveCwd;
    this.storage = new SessionStorage(this.fs, this.sessionDir);
    this.permissions = opts.options?.permissions;
    this.hooks = opts.options?.hooks ?? [];
    this.enableSubagents = opts.options?.enableSubagents ?? false;
    this.enableTasks = opts.options?.enableTasks ?? false;
    if (this.enableTasks) {
      const tasksDir = opts.options?.tasksDir ?? ".noumen/tasks";
      this.taskStore = new TaskStore(this.fs, tasksDir);
    }
    this.enablePlanMode = opts.options?.enablePlanMode ?? false;
    this.enableWorktrees = opts.options?.enableWorktrees ?? false;
    this.lspConfigs = resolved.lspConfigs as Record<string, LspServerConfig> | undefined;
    this.streamingToolExecution = opts.options?.streamingToolExecution ?? false;
    this.webSearchConfig = opts.options?.webSearch;
    this.userInputHandler = opts.options?.userInputHandler;
    this.thinkingConfig = opts.options?.thinking;
    this.retryConfig = resolved.retryConfig;

    if (opts.options?.costTracking?.enabled) {
      this.costTracker = new CostTracker(opts.options.costTracking.pricing);
    }

    if (resolved.mcpServerConfigs) {
      this.mcpServerConfigs = resolved.mcpServerConfigs as Record<string, McpServerConfig>;
      this.mcpTokenStorage = opts.options?.mcpTokenStorage;
      this.mcpOnAuthorizationUrl = opts.options?.mcpOnAuthorizationUrl;
    }

    this.tracer = opts.options?.tracing?.tracer;

    if (opts.options?.memory) {
      this.memoryConfig = opts.options.memory;
      this.memoryProvider = opts.options.memory.provider;
    }

    this.microcompactConfig = opts.options?.microcompact;
    this.toolResultBudgetConfig = opts.options?.toolResultBudget;
    this.reactiveCompactConfig = opts.options?.reactiveCompact;
    this.toolSearchEnabled = opts.options?.toolSearch ?? false;
    this.projectContextConfig = resolved.projectContextConfig;
    this.promptCachingConfig = opts.options?.promptCaching;
    this.fileStateCacheConfig = opts.options?.fileStateCache;
    this.toolResultStorageConfig = opts.options?.toolResultStorage;
    this.historySnipConfig = opts.options?.historySnip;
    this.outputFormat = opts.options?.outputFormat;
    this.structuredOutputMode = opts.options?.structuredOutputMode;

    if (opts.options?.checkpoint?.enabled) {
      this.checkpointManager = new FileCheckpointManager(
        this.fs,
        opts.options.checkpoint,
      );
    }
  }

  private async ensureProvider(): Promise<AIProvider> {
    if (this.resolvedProvider) return this.resolvedProvider;
    if (!this.providerPromise) {
      this.providerPromise = (async () => {
        const { resolveProvider } = await import("./providers/resolve.js");
        return resolveProvider(this.providerInput, { model: this.model });
      })();
    }
    this.resolvedProvider = await this.providerPromise;
    return this.resolvedProvider;
  }

  private getProvider(): AIProvider {
    if (!this.resolvedProvider) {
      throw new Error(
        "Provider not yet resolved. Call init() first when using a string provider.",
      );
    }
    return this.resolvedProvider;
  }

  private async getSkills(): Promise<SkillDefinition[]> {
    if (this.resolvedSkills) return this.resolvedSkills;

    const ctx = await buildUserContext({
      fs: this.fs,
      skillsPaths: this.skillsPaths,
      inlineSkills: this.skills,
    });

    this.resolvedSkills = ctx.skills;
    return this.resolvedSkills;
  }

  private getAllTools(): Tool[] {
    const tools = [...this.tools, ...this.mcpTools, ...this.mcpAuthTools];
    if (this.enableSubagents) {
      tools.push(agentTool);
    }
    if (this.enableTasks) {
      tools.push(taskCreateTool, taskListTool, taskGetTool, taskUpdateTool);
    }
    if (this.enablePlanMode) {
      tools.push(enterPlanModeTool, exitPlanModeTool);
    }
    if (this.enableWorktrees) {
      tools.push(enterWorktreeTool, exitWorktreeTool);
    }
    if (this.lspManager && this.lspToolRef) {
      tools.push(this.lspToolRef);
    }
    if (this.webSearchConfig) {
      tools.push(createWebSearchTool(this.webSearchConfig));
    }
    return tools;
  }

  private createSpawnSubagent(getCwd: () => string): (config: SubagentConfig) => SubagentRun {
    return (config: SubagentConfig): SubagentRun => {
      const parentCwd = getCwd();
      const parentTools = this.getAllTools().filter((t) => t.name !== "Agent");
      const childTools = config.allowedTools
        ? parentTools.filter((t) => config.allowedTools!.includes(t.name))
        : parentTools;

      const childThread = new Thread(
        {
          provider: this.getProvider(),
          fs: this.fs,
          computer: this.computer,
          sessionDir: this.sessionDir,
          skills: this.resolvedSkills ?? this.skills,
          tools: childTools,
          systemPrompt: config.systemPrompt ?? this.systemPrompt,
          model: config.model ?? this.model,
          maxTokens: this.maxTokens,
          autoCompact: createAutoCompactConfig({ enabled: false }),
          permissions: config.permissionMode
            ? { mode: config.permissionMode }
            : { mode: "bypassPermissions" },
          hooks: this.hooks,
          taskStore: this.taskStore ?? undefined,
          lspManager: this.lspManager ?? undefined,
          thinking: this.thinkingConfig,
          retry: this.retryConfig,
          costTracker: this.costTracker ?? undefined,
          tracer: this.tracer,
          memory: this.memoryConfig,
          checkpointManager: this.checkpointManager ?? undefined,
          fileStateCacheConfig: this.fileStateCacheConfig,
          toolResultStorage: this.toolResultStorageConfig,
          historySnip: this.historySnipConfig,
          promptCachingEnabled: this.promptCachingConfig?.enabled ?? false,
          skipCacheWrite: true,
          projectContext: this.resolvedProjectContext ?? undefined,
        },
        { cwd: parentCwd },
      );

      return {
        sessionId: childThread.sessionId,
        events: childThread.run(config.prompt),
      };
    };
  }

  async createThread(opts?: ThreadOptions): Promise<Thread> {
    await this.init();

    if (this.sandbox.init) {
      let storedSandboxId: string | undefined;
      if (opts?.resume && opts?.sessionId) {
        storedSandboxId = await this.loadSandboxId(opts.sessionId);
      }
      await this.sandbox.init(storedSandboxId);
    }

    const autoCompact = createAutoCompactConfig({
      enabled: this.autoCompactEnabled,
      threshold: this.autoCompactThreshold,
      model: this.model,
    });

    const skills = this.resolvedSkills ?? this.skills;
    const cwd = opts?.cwd ?? this.cwd;

    let thread!: Thread;
    thread = new Thread(
      {
        provider: this.getProvider(),
        fs: this.fs,
        computer: this.computer,
        sessionDir: this.sessionDir,
        skills,
        tools: this.getAllTools(),
        systemPrompt: this.systemPrompt,
        model: this.model,
        maxTokens: this.maxTokens,
        autoCompact,
        microcompact: this.microcompactConfig,
        toolResultBudget: this.toolResultBudgetConfig,
        reactiveCompact: this.reactiveCompactConfig,
        permissions: opts?.permissionHandler
          ? { ...this.permissions, handler: opts.permissionHandler }
          : this.permissions,
        hooks: this.hooks,
        spawnSubagent: this.enableSubagents
          ? this.createSpawnSubagent(() => thread.getCwd())
          : undefined,
        streamingToolExecution: this.streamingToolExecution,
        userInputHandler: opts?.userInputHandler ?? this.userInputHandler,
        taskStore: this.taskStore ?? undefined,
        lspManager: this.lspManager ?? undefined,
        thinking: this.thinkingConfig,
        retry: this.retryConfig,
        costTracker: this.costTracker ?? undefined,
        tracer: this.tracer,
        memory: this.memoryConfig,
        toolSearchEnabled: this.toolSearchEnabled,
        checkpointManager: this.checkpointManager ?? undefined,
        fileStateCacheConfig: this.fileStateCacheConfig,
        toolResultStorage: this.toolResultStorageConfig,
        historySnip: this.historySnipConfig,
        promptCachingEnabled: this.promptCachingConfig?.enabled ?? false,
        mcpToolNames: this.mcpToolNames.size > 0 ? this.mcpToolNames : undefined,
        projectContext: this.resolvedProjectContext ?? undefined,
        outputFormat: this.outputFormat,
        structuredOutputMode: this.structuredOutputMode,
      },
      {
        ...opts,
        cwd,
      },
    );

    const sid = this.sandbox.sandboxId?.();
    if (sid && !(opts?.resume)) {
      await this.storeSandboxId(thread.sessionId, sid);
    }

    return thread;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.storage.listSessions();
  }

  getCostSummary(): import("./cost/types.js").CostSummary | null {
    return this.costTracker?.getSummary() ?? null;
  }

  /**
   * Create a thread that resumes an existing session. Automatically restores
   * messages (respecting compact boundaries), file checkpoint state, and
   * cost tracking state from the persisted JSONL transcript.
   */
  async resumeThread(sessionId: string, opts?: Omit<ThreadOptions, "sessionId" | "resume">): Promise<Thread> {
    return this.createThread({
      ...opts,
      sessionId,
      resume: true,
    });
  }

  /**
   * One-shot streaming: creates an ephemeral thread and yields events.
   * Auto-resolves string providers on first call (no need to call `init()`).
   *
   * ```ts
   * for await (const event of agent.run("Fix the bug")) {
   *   if (event.type === "text_delta") process.stdout.write(event.text);
   * }
   * ```
   */
  async *run(
    prompt: string | ContentPart[],
    opts?: RunOptions & ThreadOptions,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    await this.init();
    const thread = await this.createThread(opts);
    yield* thread.run(prompt, opts);
  }

  /**
   * One-shot execution: runs the prompt to completion and returns a result
   * summary. Optional callbacks fire as events arrive.
   *
   * ```ts
   * const result = await agent.execute("Fix the bug", {
   *   onText: (text) => process.stdout.write(text),
   * });
   * console.log(`Done — ${result.toolCalls} tool calls`);
   * ```
   */
  async execute(
    prompt: string | ContentPart[],
    opts?: RunOptions & ThreadOptions & RunCallbacks,
  ): Promise<RunResult> {
    await this.init();
    const thread = await this.createThread(opts);
    let text = "";
    let toolCalls = 0;
    let lastUsage: ChatCompletionUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    for await (const event of thread.run(prompt, opts)) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          opts?.onText?.(event.text);
          break;
        case "thinking_delta":
          opts?.onThinking?.(event.text);
          break;
        case "tool_use_start":
          toolCalls++;
          opts?.onToolUse?.(event.toolName, {});
          break;
        case "tool_result":
          opts?.onToolResult?.(event.toolName, event.result);
          break;
        case "error":
          opts?.onError?.(event.error);
          break;
        case "turn_complete":
          lastUsage = event.usage;
          break;
      }
    }

    const result: RunResult = {
      text,
      toolCalls,
      usage: lastUsage,
      sessionId: thread.sessionId,
    };

    opts?.onComplete?.(result);
    return result;
  }

  /**
   * Pre-resolve the provider (if string), skills, MCP servers, and LSP servers.
   * Call this once after construction if using a string provider, skillsPaths,
   * mcpServers, or lsp, so that createThread() has everything available synchronously.
   */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const tasks: Promise<void>[] = [
      this.ensureProvider().then(() => {}),
      this.getSkills().then(() => {}),
    ];

    if (this.projectContextConfig && !this.resolvedProjectContext) {
      tasks.push(
        loadProjectContext(this.fs, this.projectContextConfig).then((files) => {
          this.resolvedProjectContext = files;
        }),
      );
    }

    if (this.mcpServerConfigs && !this.mcpManager) {
      tasks.push(
        (async () => {
          const { McpClientManager: McpMgr } = await import("./mcp/client.js");
          this.mcpManager = new McpMgr(this.mcpServerConfigs!, {
            tokenStorage: this.mcpTokenStorage,
            onAuthorizationUrl: this.mcpOnAuthorizationUrl,
          });
          await this.mcpManager.connect();
          this.mcpTools = await this.mcpManager.getTools();
          this.mcpToolNames = new Set(this.mcpTools.map((t) => t.name));

          const needsAuth = this.mcpManager.getServersNeedingAuth();
          if (needsAuth.length > 0) {
            const { createMcpAuthTool } = await import("./tools/mcp-auth.js");
            this.mcpAuthTools = needsAuth.map((name) =>
              createMcpAuthTool(name, this.mcpManager!),
            );
          }
        })(),
      );
    }

    if (this.lspConfigs && !this.lspManager) {
      tasks.push(
        (async () => {
          const { LspServerManager } = await import("./lsp/manager.js");
          const { lspTool } = await import("./tools/lsp.js");
          const rootUri = `file://${this.cwd}`;
          this.lspManager = new LspServerManager(this.lspConfigs!, rootUri);
          this.lspToolRef = lspTool;
        })(),
      );
    }

    await Promise.all(tasks);
  }

  /**
   * Run health checks on the provider, sandbox, MCP servers, and LSP servers.
   * Returns a structured report — useful for debugging integration issues.
   *
   * @param timeoutMs Per-check timeout in milliseconds (default 10 000).
   */
  async diagnose(timeoutMs = 10_000): Promise<DiagnoseResult> {
    const providerCheck = await checkProviderHealth(this.getProvider(), this.model, timeoutMs);
    const fsCheck = await checkVirtualFs(this.fs, timeoutMs);
    const computerCheck = await checkVirtualComputer(this.computer, timeoutMs);
    const sandboxRuntimeCheck = await checkSandboxRuntime();

    const mcpResults = this.mcpManager
      ? summarizeMcpStatus(this.mcpManager.getConnectionStatus())
      : {};

    const lspResults = this.lspManager
      ? summarizeLspStatus(this.lspManager.getServerStatus())
      : {};

    const overall = providerCheck.ok && fsCheck.ok && computerCheck.ok;

    return {
      overall,
      provider: providerCheck,
      sandbox: { fs: fsCheck, computer: computerCheck },
      sandboxRuntime: sandboxRuntimeCheck,
      mcp: mcpResults,
      lsp: lspResults,
      timestamp: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Sandbox index — local host file mapping sessionId → sandboxId so we can
  // reconnect to auto-created containers on resume without accessing the
  // (potentially unreachable) sandbox filesystem.
  // ---------------------------------------------------------------------------

  private get sandboxIndexPath(): string {
    return nodePath.resolve(this.cwd, this.sessionDir, ".sandbox-index.json");
  }

  private async loadSandboxId(sessionId: string): Promise<string | undefined> {
    try {
      const content = await nodeFs.readFile(this.sandboxIndexPath, "utf-8");
      const index = JSON.parse(content) as Record<string, string>;
      return index[sessionId];
    } catch {
      return undefined;
    }
  }

  private async storeSandboxId(sessionId: string, sandboxId: string): Promise<void> {
    let index: Record<string, string> = {};
    try {
      const content = await nodeFs.readFile(this.sandboxIndexPath, "utf-8");
      index = JSON.parse(content) as Record<string, string>;
    } catch { /* file doesn't exist yet */ }
    index[sessionId] = sandboxId;
    await nodeFs.mkdir(nodePath.dirname(this.sandboxIndexPath), { recursive: true });
    await nodeFs.writeFile(this.sandboxIndexPath, JSON.stringify(index, null, 2));
  }

  /**
   * Disconnect all MCP clients. Call when done with this Agent instance.
   */
  async close(): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (this.mcpManager) {
      tasks.push(
        this.mcpManager.close().then(() => {
          this.mcpTools = [];
          this.mcpAuthTools = [];
          this.mcpToolNames.clear();
          this.mcpManager = null;
        }),
      );
    }
    if (this.lspManager) {
      tasks.push(
        this.lspManager.shutdown().then(() => {
          this.lspManager = null;
          this.lspToolRef = null;
        }),
      );
    }
    if (this.sandbox.dispose) {
      tasks.push(this.sandbox.dispose());
    }
    await Promise.all(tasks);
    this.initPromise = null;
    this.providerPromise = null;
  }
}
