import type { Tool } from "./types.js";

export const taskGetTool: Tool = {
  name: "TaskGet",
  description: "Get details of a specific task by ID.",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The task ID to retrieve",
      },
    },
    required: ["taskId"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(args, ctx) {
    if (!ctx.taskStore) {
      return { content: "Task management is not enabled.", isError: true };
    }
    const task = await ctx.taskStore.get(args.taskId as string);
    if (!task) {
      return { content: `Task ${args.taskId} not found.`, isError: true };
    }
    return { content: JSON.stringify({ task }, null, 2) };
  },
};
