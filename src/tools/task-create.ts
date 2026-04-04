import type { Tool } from "./types.js";

export const taskCreateTool: Tool = {
  name: "TaskCreate",
  description:
    "Create a new task/todo item for tracking work. Use this to decompose complex work into trackable steps.",
  parameters: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description: "Short title for the task",
      },
      description: {
        type: "string",
        description: "Optional detailed description of the task",
      },
    },
    required: ["subject"],
  },
  isReadOnly: false,
  isConcurrencySafe: true,

  async call(args, ctx) {
    if (!ctx.taskStore) {
      return { content: "Task management is not enabled.", isError: true };
    }
    const subject = args.subject as string;
    const description = args.description as string | undefined;

    const task = await ctx.taskStore.create({ subject, description });
    return {
      content: JSON.stringify({ id: task.id, subject: task.subject }),
    };
  },
};
