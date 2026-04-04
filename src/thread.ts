import type { AIProvider } from "./providers/types.js";
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
import type { Tool, ToolContext } from "./tools/types.js";
import { ToolRegistry } from "./tools/registry.js";
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

  constructor(config: ThreadConfig, opts?: ThreadOptions) {
    this.config = config;
    this.sessionId = opts?.sessionId ?? generateUUID();
    this.cwd = opts?.cwd ?? "/";
    this.model = opts?.model ?? config.model ?? "gpt-4o";
    this.storage = new SessionStorage(config.fs, config.sessionDir);

    const extraTools = [...(config.tools ?? [])];

    // Add the Skill tool when skills are configured
    const allSkills = config.skills ?? [];
    if (allSkills.length > 0) {
      extraTools.push(
        createSkillTool(() => getActiveSkills(allSkills, this.activatedSkills)),
      );
    }

    this.toolRegistry = new ToolRegistry(extraTools.length > 0 ? extraTools : undefined);

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
      };

      while (!signal.aborted) {
        const accumulatedContent: string[] = [];
        const accumulatedToolCalls = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();
        let finishReason: string | null = null;

        const stream = this.config.aiProvider.chat({
          model: this.model,
          messages: this.messages,
          tools: toolDefs,
          system: systemPrompt,
          max_tokens: this.config.maxTokens,
        });

        for await (const chunk of stream) {
          if (signal.aborted) break;

          for (const choice of chunk.choices) {
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta;

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
                  });

                  if (tc.id && tc.function?.name) {
                    yield {
                      type: "tool_use_start",
                      toolName: name,
                      toolUseId: id,
                    };
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
        }

        if (signal.aborted) break;

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

          for (const tc of toolCalls) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments);
            } catch {
              // malformed JSON from model
            }

            const result = await this.toolRegistry.execute(
              tc.function.name,
              parsedArgs,
              toolCtx,
            );

            yield {
              type: "tool_result",
              toolUseId: tc.id,
              toolName: tc.function.name,
              result,
            };

            const toolResultMsg: ChatMessage = {
              role: "tool",
              tool_call_id: tc.id,
              content: result.content,
            };

            this.messages.push(toolResultMsg);
            await this.storage.appendMessage(this.sessionId, toolResultMsg);

            if (FILE_TOOLS.has(tc.function.name) && typeof parsedArgs.file_path === "string") {
              touchedFilePaths.push(parsedArgs.file_path);
            }
          }

          // Activate conditional skills when file tools touch matching paths
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

          continue;
        }

        yield { type: "message_complete", message: assistantMsg };
        break;
      }

      const autoCompactConfig =
        this.config.autoCompact ?? createAutoCompactConfig();
      if (shouldAutoCompact(this.messages, autoCompactConfig)) {
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
        } catch (err) {
          yield {
            type: "error",
            error:
              err instanceof Error
                ? err
                : new Error(`Compaction failed: ${String(err)}`),
          };
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        yield {
          type: "error",
          error:
            err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
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
