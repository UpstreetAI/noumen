import type { Tool } from "./types.js";
import type { TaskStatus } from "../tasks/types.js";

export const taskUpdateTool: Tool = {
  name: "TaskUpdate",
  description:
    "Update a task's status, description, or dependencies. Set status to 'completed' when done, or 'deleted' to remove.",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The task ID to update",
      },
      status: {
        type: "string",
        description: "New status: pending, in_progress, completed, or deleted",
        enum: ["pending", "in_progress", "completed", "deleted"],
      },
      description: {
        type: "string",
        description: "Updated description",
      },
      owner: {
        type: "string",
        description: "Name of the agent/user that owns this task",
      },
      blockedBy: {
        type: "string",
        description:
          "Comma-separated list of task IDs that must complete before this task",
      },
    },
    required: ["taskId"],
  },
  isReadOnly: false,
  isConcurrencySafe: true,

  async call(args, ctx) {
    if (!ctx.taskStore) {
      return { content: "Task management is not enabled.", isError: true };
    }

    const taskId = args.taskId as string;
    const status = args.status as string | undefined;

    if (status === "deleted") {
      const deleted = await ctx.taskStore.delete(taskId);
      if (!deleted) {
        return { content: `Task ${taskId} not found.`, isError: true };
      }
      return { content: JSON.stringify({ success: true, taskId, deleted: true }) };
    }

    const blockedByRaw = args.blockedBy as string | undefined;
    const blockedBy = blockedByRaw
      ? blockedByRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const task = await ctx.taskStore.update(taskId, {
      status: status as TaskStatus | undefined,
      description: args.description as string | undefined,
      owner: args.owner as string | undefined,
      blockedBy,
    });

    if (!task) {
      return { content: `Task ${taskId} not found.`, isError: true };
    }

    return {
      content: JSON.stringify({
        success: true,
        taskId,
        updatedFields: Object.keys(args).filter((k) => k !== "taskId"),
      }),
    };
  },
};
