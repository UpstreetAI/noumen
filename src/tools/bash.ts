import type { Tool, ToolResult, ToolContext } from "./types.js";
import { classifyCommand } from "./shell-safety/command-classification.js";

const MAX_OUTPUT_CHARS = 100_000;

export const bashTool: Tool = {
  name: "Bash",
  description:
    "Execute a bash shell command. Use this for running scripts, " +
    "installing packages, git operations, and other system commands.",
  isReadOnly(args) {
    const command = args.command as string;
    return classifyCommand(command).isReadOnly;
  },
  isDestructive(args) {
    const command = args.command as string;
    return classifyCommand(command).isDestructive;
  },
  checkPermissions(args) {
    const command = args.command as string;
    const classification = classifyCommand(command);
    if (classification.isDestructive) {
      return {
        behavior: "ask" as const,
        message: `Destructive command: ${command}${classification.reason ? ` (${classification.reason})` : ""}`,
      };
    }
    return {
      behavior: "passthrough" as const,
      message: `Execute: ${command}`,
    };
  },
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000)",
      },
      description: {
        type: "string",
        description: "Short description of what this command does (5-10 words)",
      },
    },
    required: ["command"],
  },

  async call(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const command = args.command as string;
    const timeout = args.timeout as number | undefined;

    try {
      const result = await ctx.computer.executeCommand(command, {
        timeout,
        cwd: ctx.cwd,
      });

      let output = "";
      if (result.stdout) {
        output += result.stdout;
      }
      if (result.stderr) {
        if (output) output += "\n";
        output += `STDERR:\n${result.stderr}`;
      }

      if (!output.trim()) {
        output = "(no output)";
      }

      if (output.length > MAX_OUTPUT_CHARS) {
        output =
          output.slice(0, MAX_OUTPUT_CHARS) +
          `\n... output truncated (${output.length} total chars)`;
      }

      if (result.exitCode !== 0) {
        output = `Exit code: ${result.exitCode}\n${output}`;
      }

      return {
        content: output,
        isError: result.exitCode !== 0,
      };
    } catch (err) {
      return {
        content: `Error executing command: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
