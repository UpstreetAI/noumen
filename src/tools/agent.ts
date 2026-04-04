import type { Tool, ToolResult, ToolContext } from "./types.js";
import { runNotificationHooks } from "../hooks/runner.js";
import { AGENT_PROMPT } from "./prompts/agent.js";

const DEFAULT_MAX_TURNS = 25;

export const agentTool: Tool = {
  name: "Agent",
  description:
    "Spawn an isolated subagent to handle a focused subtask. The subagent " +
    "runs in its own conversation context and returns its final response. " +
    "Use for tasks that benefit from independent context (research, " +
    "code generation, analysis) or when you want to parallelise work.",
  prompt: AGENT_PROMPT,
  isReadOnly: false,
  isConcurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The task description for the subagent. Be specific about what to do and what to return.",
      },
      systemPrompt: {
        type: "string",
        description: "Optional system prompt override for the subagent.",
      },
      allowedTools: {
        type: "string",
        description:
          "Comma-separated list of tool names the subagent may use. Omit to inherit all parent tools except Agent.",
      },
      async: {
        type: "string",
        description:
          'Set to "true" to run the agent in the background and return immediately with a taskId. ' +
          "Check status with TaskGet.",
        enum: ["true", "false"],
      },
    },
    required: ["prompt"],
  },

  async call(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!ctx.spawnSubagent) {
      return {
        content: "Subagents are not enabled. Set enableSubagents: true in CodeOptions.",
        isError: true,
      };
    }

    const prompt = args.prompt as string;
    const systemPrompt = args.systemPrompt as string | undefined;
    const allowedToolsRaw = args.allowedTools as string | undefined;
    const allowedTools = allowedToolsRaw
      ? allowedToolsRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
    const isAsync = args.async === "true";

    const maxTurns = DEFAULT_MAX_TURNS;
    const { sessionId, events } = ctx.spawnSubagent({
      prompt,
      systemPrompt,
      allowedTools,
      maxTurns,
    });

    // Fire SubagentStart hook
    if (ctx.hooks && ctx.hooks.length > 0) {
      await runNotificationHooks(ctx.hooks, "SubagentStart", {
        event: "SubagentStart",
        sessionId,
        parentSessionId: ctx.sessionId ?? "",
        prompt,
      });
    }

    if (isAsync && ctx.taskStore) {
      const task = await ctx.taskStore.create({
        subject: `Agent: ${prompt.slice(0, 80)}`,
        description: `Async agent running with sessionId: ${sessionId}`,
      });
      await ctx.taskStore.update(task.id, { status: "in_progress" });

      // Fire and forget — collect results into task store when done.
      (async () => {
        const assistantTexts: string[] = [];
        try {
          for await (const event of events) {
            if (event.type === "message_complete" && event.message.content) {
              assistantTexts.push(event.message.content);
            }
            if (event.type === "turn_complete") break;
          }
          const result = assistantTexts.join("\n\n") || "(no output)";
          await ctx.taskStore!.update(task.id, {
            status: "completed",
            description: result.slice(0, 10_000),
          });
          if (ctx.hooks && ctx.hooks.length > 0) {
            await runNotificationHooks(ctx.hooks, "SubagentStop", {
              event: "SubagentStop",
              sessionId,
              parentSessionId: ctx.sessionId ?? "",
              result,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.taskStore!.update(task.id, {
            status: "completed",
            description: `Error: ${msg}`,
          });
          if (ctx.hooks && ctx.hooks.length > 0) {
            await runNotificationHooks(ctx.hooks, "SubagentStop", {
              event: "SubagentStop",
              sessionId,
              parentSessionId: ctx.sessionId ?? "",
              result: `Error: ${msg}`,
            });
          }
        }
      })();

      return {
        content: JSON.stringify({
          taskId: task.id,
          sessionId,
          message: "Agent launched in background. Use TaskGet to check status.",
        }),
      };
    }

    // Synchronous mode (original behavior)
    const assistantTexts: string[] = [];
    let turnCount = 0;

    try {
      for await (const event of events) {
        if (event.type === "message_complete" && event.message.content) {
          assistantTexts.push(event.message.content);
        }
        if (event.type === "turn_complete") {
          turnCount++;
          if (turnCount >= maxTurns) {
            break;
          }
        }
        if (event.type === "error") {
          const errorResult = `Subagent error: ${event.error.message}`;
          if (ctx.hooks && ctx.hooks.length > 0) {
            await runNotificationHooks(ctx.hooks, "SubagentStop", {
              event: "SubagentStop",
              sessionId,
              parentSessionId: ctx.sessionId ?? "",
              result: errorResult,
            });
          }
          return { content: errorResult, isError: true };
        }
      }
    } catch (err) {
      const errorResult = `Subagent failed: ${err instanceof Error ? err.message : String(err)}`;
      if (ctx.hooks && ctx.hooks.length > 0) {
        await runNotificationHooks(ctx.hooks, "SubagentStop", {
          event: "SubagentStop",
          sessionId,
          parentSessionId: ctx.sessionId ?? "",
          result: errorResult,
        });
      }
      return { content: errorResult, isError: true };
    }

    const result = assistantTexts.join("\n\n");

    if (ctx.hooks && ctx.hooks.length > 0) {
      await runNotificationHooks(ctx.hooks, "SubagentStop", {
        event: "SubagentStop",
        sessionId,
        parentSessionId: ctx.sessionId ?? "",
        result: result || "(subagent produced no output)",
      });
    }

    return {
      content: result || "(subagent produced no output)",
    };
  },
};
