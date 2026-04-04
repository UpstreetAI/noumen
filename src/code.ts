import type { AIProvider } from "./providers/types.js";
import type { VirtualFs } from "./virtual/fs.js";
import type { VirtualComputer } from "./virtual/computer.js";
import type { Sandbox } from "./virtual/sandbox.js";
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

export interface CodeOptions {
  aiProvider: AIProvider;

  /**
   * Bundled sandbox providing both filesystem and shell execution.
   * Use `LocalSandbox()` for unsandboxed local development,
   * `SpritesSandbox()` for isolated remote containers, or pass any
   * `{ fs: VirtualFs; computer: VirtualComputer }` for custom sandboxes.
   */
  sandbox?: Sandbox;

  /**
   * @deprecated Use `sandbox` instead. Filesystem sandbox — all file I/O
   * from tools routes through this interface.
   */
  virtualFs?: VirtualFs;

  /**
   * @deprecated Use `sandbox` instead. Shell execution sandbox — all command
   * execution from tools routes through this interface.
   */
  virtualComputer?: VirtualComputer;

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
  };
}

export class Code {
  private aiProvider: AIProvider;
  private fs: VirtualFs;
  private computer: VirtualComputer;
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
  private checkpointManager: FileCheckpointManager | null = null;
  private promptCachingConfig: CacheControlConfig | undefined;
  private fileStateCacheConfig: FileStateCacheConfig | undefined;
  private toolResultStorageConfig: ToolResultStorageConfig | undefined;
  private historySnipConfig: SnipConfig | undefined;

  constructor(opts: CodeOptions) {
    this.aiProvider = opts.aiProvider;

    const fs = opts.sandbox?.fs ?? opts.virtualFs;
    const computer = opts.sandbox?.computer ?? opts.virtualComputer;
    if (!fs || !computer) {
      throw new Error(
        "Provide either `sandbox` or both `virtualFs` and `virtualComputer`.",
      );
    }
    this.fs = fs;
    this.computer = computer;
    this.sessionDir = opts.options?.sessionDir ?? ".noumen/sessions";
    this.skills = opts.options?.skills ?? [];
    this.skillsPaths = opts.options?.skillsPaths ?? [];
    this.tools = opts.options?.tools ?? [];
    this.systemPrompt = opts.options?.systemPrompt;
    this.model = opts.options?.model;
    this.maxTokens = opts.options?.maxTokens;
    this.autoCompactEnabled = opts.options?.autoCompact ?? true;
    this.autoCompactThreshold = opts.options?.autoCompactThreshold;
    this.cwd = opts.options?.cwd ?? "/";
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
    if (opts.options?.lsp && Object.keys(opts.options.lsp).length > 0) {
      this.lspConfigs = opts.options.lsp;
    }
    this.streamingToolExecution = opts.options?.streamingToolExecution ?? false;
    this.webSearchConfig = opts.options?.webSearch;
    this.userInputHandler = opts.options?.userInputHandler;
    this.thinkingConfig = opts.options?.thinking;

    if (opts.options?.retry === true) {
      this.retryConfig = DEFAULT_RETRY_CONFIG;
    } else if (typeof opts.options?.retry === "object") {
      this.retryConfig = opts.options.retry;
    }

    if (opts.options?.costTracking?.enabled) {
      this.costTracker = new CostTracker(opts.options.costTracking.pricing);
    }

    if (opts.options?.mcpServers && Object.keys(opts.options.mcpServers).length > 0) {
      this.mcpServerConfigs = opts.options.mcpServers;
      this.mcpTokenStorage = opts.options.mcpTokenStorage;
      this.mcpOnAuthorizationUrl = opts.options.mcpOnAuthorizationUrl;
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
    this.promptCachingConfig = opts.options?.promptCaching;
    this.fileStateCacheConfig = opts.options?.fileStateCache;
    this.toolResultStorageConfig = opts.options?.toolResultStorage;
    this.historySnipConfig = opts.options?.historySnip;

    if (opts.options?.checkpoint?.enabled) {
      this.checkpointManager = new FileCheckpointManager(
        this.fs,
        opts.options.checkpoint,
      );
    }
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

  private createSpawnSubagent(parentCwd: string): (config: SubagentConfig) => SubagentRun {
    return (config: SubagentConfig): SubagentRun => {
      const parentTools = this.getAllTools().filter((t) => t.name !== "Agent");
      const childTools = config.allowedTools
        ? parentTools.filter((t) => config.allowedTools!.includes(t.name))
        : parentTools;

      const childThread = new Thread(
        {
          aiProvider: this.aiProvider,
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
        },
        { cwd: parentCwd },
      );

      return {
        sessionId: childThread.sessionId,
        events: childThread.run(config.prompt),
      };
    };
  }

  createThread(opts?: ThreadOptions): Thread {
    const autoCompact = createAutoCompactConfig({
      enabled: this.autoCompactEnabled,
      threshold: this.autoCompactThreshold,
      model: this.model,
    });

    const skills = this.resolvedSkills ?? this.skills;
    const cwd = opts?.cwd ?? this.cwd;

    return new Thread(
      {
        aiProvider: this.aiProvider,
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
        permissions: this.permissions,
        hooks: this.hooks,
        spawnSubagent: this.enableSubagents
          ? this.createSpawnSubagent(cwd)
          : undefined,
        streamingToolExecution: this.streamingToolExecution,
        userInputHandler: this.userInputHandler,
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
      },
      {
        ...opts,
        cwd,
      },
    );
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
  resumeThread(sessionId: string, opts?: Omit<ThreadOptions, "sessionId" | "resume">): Thread {
    return this.createThread({
      ...opts,
      sessionId,
      resume: true,
    });
  }

  /**
   * Pre-resolve skills, connect to MCP servers, and start LSP servers.
   * Call this once after construction if using skillsPaths, mcpServers,
   * or lsp, so that createThread() has everything available synchronously.
   */
  async init(): Promise<void> {
    const tasks: Promise<void>[] = [this.getSkills().then(() => {})];

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
   * Disconnect all MCP clients. Call when done with this Code instance.
   */
  async close(): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (this.mcpManager) {
      tasks.push(
        this.mcpManager.close().then(() => {
          this.mcpTools = [];
          this.mcpAuthTools = [];
        }),
      );
    }
    if (this.lspManager) {
      tasks.push(this.lspManager.shutdown());
    }
    await Promise.all(tasks);
  }
}
