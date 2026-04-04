import type { Tool, ToolResult, ToolContext } from "./types.js";

export type UserInputHandler = (question: string) => Promise<string>;

export const askUserTool: Tool = {
  name: "AskUser",
  description:
    "Ask the user a question and wait for their response. Use when you need " +
    "clarification, confirmation, or additional information before proceeding.",
  isReadOnly: true,
  isConcurrencySafe: false,
  requiresUserInteraction: true,
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user",
      },
    },
    required: ["question"],
  },

  async call(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const question = args.question as string;

    if (!ctx.userInputHandler) {
      return {
        content:
          "Cannot ask user: no userInputHandler configured. " +
          "Set userInputHandler in AgentOptions or ThreadConfig.",
        isError: true,
      };
    }

    try {
      const answer = await ctx.userInputHandler(question);
      return { content: answer };
    } catch (err) {
      return {
        content: `Error getting user input: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
