import type { Tool } from "./types.js";

export const taskListTool: Tool = {
  name: "TaskList",
  description:
    "List all tasks with their current status and dependency information.",
  parameters: {
    type: "object",
    properties: {},
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(_args, ctx) {
    if (!ctx.taskStore) {
      return { content: "Task management is not enabled.", isError: true };
    }
    const tasks = await ctx.taskStore.list();

    const filtered = tasks.map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      owner: t.owner,
      blockedBy: t.blockedBy.filter((dep) => {
        const blocking = tasks.find((bt) => bt.id === dep);
        return blocking && blocking.status !== "completed";
      }),
    }));

    return { content: JSON.stringify({ tasks: filtered }, null, 2) };
  },
};
