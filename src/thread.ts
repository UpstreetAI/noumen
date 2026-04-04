import type { AIProvider, ChatCompletionUsage } from "./providers/types.js";
import type { VirtualFs } from "./virtual/fs.js";
import type { VirtualComputer } from "./virtual/computer.js";
import type {
  ChatMessage,
  AssistantMessage,
  ToolCallContent,
  StreamEvent,
  RunOptions,
} from "./session/types.js";
import type { SkillDefinition } from "./skills/types.js";
import type { Tool, ToolContext, SubagentConfig, SubagentRun } from "./tools/types.js";
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
  type AutoCompactConfig,
} from "./compact/auto-compact.js";
import { generateUUID } from "./utils/uuid.js";
import { activateSkillsForPaths, getActiveSkills } from "./skills/activation.js";
import { createSkillTool } from "./tools/skill.js";
import { resolvePermission } from "./permissions/pipeline.js";
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
  permissions?: PermissionConfig;
  hooks?: HookDefinition[];
  spawnSubagent?: (config: SubagentConfig) => SubagentRun;
  streamingToolExecution?: boolean;
  userInputHandler?: (question: string) => Promise<string>;
  thinking?: ThinkingConfig;
  retry?: RetryConfig;
  costTracker?: CostTracker;
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
  private permissionContext: PermissionContext | null = null;
  private permissionHandler: PermissionHandler | null = null;
  private hooks: HookDefinition[];

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
    this.hooks = config.hooks ?? [];

    if (opts?.resume) {
      this.loaded = false;
    }
  }

  async *run(
    prompt: string,
    opts?: RunOptions,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    this.abortController = new AbortController();
    const signal = opts?.signal ?? this.abortController.signal;

    try {
      if (!this.loaded) {
        this.messages = await this.storage.loadMessages(this.sessionId);
        this.loaded = true;
      }

      const userMessage: ChatMessage = { role: "user", content: prompt };
      this.messages.push(userMessage);
      await this.storage.appendMessage(this.sessionId, userMessage);

      const allSkills = this.config.skills ?? [];
      let systemPrompt = this.buildCurrentSystemPrompt(allSkills);

      const toolDefs = this.toolRegistry.toToolDefinitions();
      const toolCtx: ToolContext = {
        fs: this.config.fs,
        computer: this.config.computer,
        cwd: this.cwd,
        spawnSubagent: this.config.spawnSubagent,
        userInputHandler: this.config.userInputHandler,
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

      while (!signal.aborted) {
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

        const chatParams = {
          model: this.model,
          messages: this.messages,
          tools: toolDefs,
          system: systemPrompt,
          max_tokens: currentMaxTokens,
          thinking: this.config.thinking,
        };

        let stream: AsyncIterable<import("./providers/types.js").ChatStreamChunk>;

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

        if (signal.aborted) break;

        callCount++;
        if (lastUsage) {
          turnUsage.prompt_tokens += lastUsage.prompt_tokens;
          turnUsage.completion_tokens += lastUsage.completion_tokens;
          turnUsage.total_tokens += lastUsage.total_tokens;
          yield { type: "usage", usage: lastUsage, model: this.model };

          if (this.config.costTracker) {
            const summary = this.config.costTracker.addUsage(
              this.model,
              lastUsage,
              apiDurationMs,
            );
            yield { type: "cost_update", summary };
          }
        }

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
              }

              const toolResultMsg: ChatMessage = {
                role: "tool",
                tool_call_id: execResult.toolCall.id,
                content: execResult.result.content,
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
                );

                if (decision.behavior === "deny") {
                  eventQueue.push({
                    type: "permission_denied",
                    toolName: tc.function.name,
                    input: currentArgs,
                    message: decision.message,
                  });
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
                      const feedback = response.feedback ?? "User denied permission.";
                      eventQueue.push({
                        type: "permission_denied",
                        toolName: tc.function.name,
                        input: currentArgs,
                        message: feedback,
                      });
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
                    eventQueue.push({
                      type: "permission_denied",
                      toolName: tc.function.name,
                      input: currentArgs,
                      message: "No permission handler configured.",
                    });
                    const content = "Permission denied: No permission handler configured.";
                    return { toolCall: tc, parsedArgs: currentArgs, result: { content, isError: true }, permissionDenied: true };
                  }
                }

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

            let result = await registry.execute(
              tc.function.name,
              currentArgs,
              toolCtx,
            );

            // --- PostToolUse hooks ---
            if (hooks.length > 0) {
              const postOutput = await runPostToolUseHooks(hooks, {
                event: "PostToolUse",
                toolName: tc.function.name,
                toolInput: currentArgs,
                toolUseId: tc.id,
                toolOutput: result.content,
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
            }

            const toolResultMsg: ChatMessage = {
              role: "tool",
              tool_call_id: tc.id,
              content: result.content,
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
          }

          if (touchedFilePaths.length > 0 && allSkills.length > 0) {
            const newlyActivated = activateSkillsForPaths(
              allSkills,
              touchedFilePaths,
              this.cwd,
              this.activatedSkills,
            );
            if (newlyActivated.length > 0) {
              systemPrompt = this.buildCurrentSystemPrompt(allSkills);
            }
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

      // --- Compaction with hooks ---
      const autoCompactConfig =
        this.config.autoCompact ?? createAutoCompactConfig();
      if (shouldAutoCompact(this.messages, autoCompactConfig)) {
        await runNotificationHooks(hooks, "PreCompact", {
          event: "PreCompact",
          sessionId: this.sessionId,
        });

        yield { type: "compact_start" };
        try {
          this.messages = await compactConversation(
            this.config.aiProvider,
            this.model,
            this.messages,
            this.storage,
            this.sessionId,
          );
          yield { type: "compact_complete" };

          await runNotificationHooks(hooks, "PostCompact", {
            event: "PostCompact",
            sessionId: this.sessionId,
          });
        } catch (err) {
          const error = err instanceof Error
            ? err
            : new Error(`Compaction failed: ${String(err)}`);

          await runNotificationHooks(hooks, "Error", {
            event: "Error",
            sessionId: this.sessionId,
            error,
          });

          yield { type: "error", error };
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        const error = err instanceof Error ? err : new Error(String(err));

        await runNotificationHooks(this.hooks, "Error", {
          event: "Error",
          sessionId: this.sessionId,
          error,
        });

        yield { type: "error", error };
      }
    }
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
          const decision = await resolvePermission(tool, currentArgs, toolCtx, permCtx);

          if (decision.behavior === "deny") {
            events.push({ type: "permission_denied", toolName: tc.function.name, input: currentArgs, message: decision.message });
            return { result: { content: `Permission denied: ${decision.message}`, isError: true }, permissionDenied: true, events };
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
                const feedback = response.feedback ?? "User denied permission.";
                events.push({ type: "permission_denied", toolName: tc.function.name, input: currentArgs, message: feedback });
                return { result: { content: `Permission denied: ${feedback}`, isError: true }, permissionDenied: true, events };
              }
              if (response.updatedInput) currentArgs = response.updatedInput;
              if (response.addRules) permCtx.rules.push(...response.addRules);
            } else {
              events.push({ type: "permission_denied", toolName: tc.function.name, input: currentArgs, message: "No permission handler configured." });
              return { result: { content: "Permission denied: No permission handler configured.", isError: true }, permissionDenied: true, events };
            }
          }

          events.push({ type: "permission_granted", toolName: tc.function.name, input: currentArgs });
        }
      }

      if (hooks.length > 0) {
        const hookOutput = await runPreToolUseHooks(hooks, {
          event: "PreToolUse", toolName: tc.function.name, toolInput: currentArgs, toolUseId: tc.id, sessionId,
        });
        if (hookOutput.decision === "deny") {
          return { result: { content: `Hook denied: ${hookOutput.message ?? "Blocked by hook."}`, isError: true }, permissionDenied: true, events };
        }
        if (hookOutput.updatedInput) currentArgs = hookOutput.updatedInput;
      }

      let result = await registry.execute(tc.function.name, currentArgs, toolCtx);

      if (hooks.length > 0) {
        const postOutput = await runPostToolUseHooks(hooks, {
          event: "PostToolUse", toolName: tc.function.name, toolInput: currentArgs, toolUseId: tc.id, toolOutput: result.content, isError: result.isError ?? false, sessionId,
        });
        if (postOutput.updatedOutput !== undefined) {
          result = { ...result, content: postOutput.updatedOutput };
        }
      }

      return { result, events };
    };
  }

  private buildCurrentSystemPrompt(allSkills: SkillDefinition[]): string {
    const activeSkills = getActiveSkills(allSkills, this.activatedSkills);
    return buildSystemPrompt({
      customPrompt: this.config.systemPrompt,
      skills: activeSkills,
      tools: this.toolRegistry.listTools(),
    });
  }

  async getMessages(): Promise<ChatMessage[]> {
    if (!this.loaded) {
      this.messages = await this.storage.loadMessages(this.sessionId);
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
  }

  abort(): void {
    this.abortController?.abort();
  }
}
