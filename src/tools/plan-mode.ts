import type { Tool } from "./types.js";

export const enterPlanModeTool: Tool = {
  name: "EnterPlanMode",
  description:
    "Enter plan mode to explore the codebase and create a plan before making changes. " +
    "In plan mode, file writes and edits are restricted. Use this when you need to " +
    "understand the codebase structure before implementing changes.",
  parameters: {
    type: "object",
    properties: {},
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(_args, ctx) {
    if (!ctx.setPermissionMode || !ctx.getPermissionMode) {
      return {
        content: "Plan mode is not enabled.",
        isError: true,
      };
    }

    const currentMode = ctx.getPermissionMode();
    if (currentMode === "plan") {
      return {
        content: "Already in plan mode.",
        isError: true,
      };
    }

    ctx.setPermissionMode("plan");

    return {
      content: JSON.stringify({
        previousMode: currentMode,
        currentMode: "plan",
        message:
          "Entered plan mode. File writes and edits are now restricted. " +
          "Use read-only tools (ReadFile, Glob, Grep, Bash with read-only commands) " +
          "to explore the codebase. When you have a plan, use ExitPlanMode to " +
          "return to the previous mode and begin implementation.",
      }),
    };
  },
};

export const exitPlanModeTool: Tool = {
  name: "ExitPlanMode",
  description:
    "Exit plan mode and return to the previous permission mode. " +
    "Optionally provide a plan summary that will be included in the conversation.",
  parameters: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description:
          "Optional plan summary describing what you intend to implement",
      },
    },
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(args, ctx) {
    if (!ctx.setPermissionMode || !ctx.getPermissionMode) {
      return {
        content: "Plan mode is not enabled.",
        isError: true,
      };
    }

    const currentMode = ctx.getPermissionMode();
    if (currentMode !== "plan") {
      return {
        content: "Not currently in plan mode.",
        isError: true,
      };
    }

    // Restore to default mode (the Thread manages prePlanMode state)
    ctx.setPermissionMode("default");

    const plan = args.plan as string | undefined;
    const result: Record<string, unknown> = {
      currentMode: "default",
      message: "Exited plan mode. You can now make changes.",
    };
    if (plan) {
      result.plan = plan;
    }

    return { content: JSON.stringify(result) };
  },
};
