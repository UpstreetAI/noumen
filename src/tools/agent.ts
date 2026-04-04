import type { Tool, ToolResult, ToolContext } from "./types.js";

const DEFAULT_MAX_TURNS = 25;

export const agentTool: Tool = {
  name: "Agent",
  description:
    "Spawn an isolated subagent to handle a focused subtask. The subagent " +
    "runs in its own conversation context and returns its final response. " +
    "Use for tasks that benefit from independent context (research, " +
    "code generation, analysis) or when you want to parallelise work.",
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

    const maxTurns = DEFAULT_MAX_TURNS;
    const { sessionId, events } = ctx.spawnSubagent({
      prompt,
      systemPrompt,
      allowedTools,
      maxTurns,
    });

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
          return {
            content: `Subagent error: ${event.error.message}`,
            isError: true,
          };
        }
      }
    } catch (err) {
      return {
        content: `Subagent failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    const result = assistantTexts.join("\n\n");
    return {
      content: result || "(subagent produced no output)",
    };
  },
};
