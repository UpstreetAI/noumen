import type { Tool, ToolResult, ToolContext } from "./types.js";

const MAX_MATCHES = 250;

export const grepTool: Tool = {
  name: "Grep",
  description:
    "Search file contents using ripgrep (rg). Supports regex patterns. " +
    "Returns matching lines with file paths and line numbers.",
  isReadOnly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression pattern to search for",
      },
      path: {
        type: "string",
        description: "File or directory to search in (defaults to cwd)",
      },
      glob: {
        type: "string",
        description:
          'Glob pattern to filter files (e.g. "*.ts", "*.{js,jsx}")',
      },
      case_insensitive: {
        type: "boolean",
        description: "Case insensitive search (default: false)",
      },
      context_lines: {
        type: "number",
        description: "Number of context lines to show before and after each match",
      },
    },
    required: ["pattern"],
  },

  async call(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const searchPath = (args.path as string | undefined) ?? ctx.cwd;
    const glob = args.glob as string | undefined;
    const caseInsensitive = args.case_insensitive as boolean | undefined;
    const contextLines = args.context_lines as number | undefined;

    const rgArgs: string[] = [
      "rg",
      "--line-number",
      "--no-heading",
      "--color=never",
      `--max-count=${MAX_MATCHES}`,
    ];

    if (caseInsensitive) rgArgs.push("-i");
    if (contextLines !== undefined) rgArgs.push(`-C${contextLines}`);
    if (glob) rgArgs.push(`--glob='${glob}'`);

    rgArgs.push(`'${pattern.replace(/'/g, "'\\''")}'`);
    rgArgs.push(".");

    const command = rgArgs.join(" ");

    try {
      const result = await ctx.computer.executeCommand(command, {
        cwd: searchPath,
      });

      if (result.exitCode === 1 && !result.stdout.trim()) {
        return { content: "No matches found." };
      }

      if (result.exitCode > 1) {
        return {
          content: `Grep error: ${result.stderr || result.stdout}`,
          isError: true,
        };
      }

      const lines = result.stdout.split("\n");
      let output = result.stdout;

      if (lines.length > MAX_MATCHES) {
        output =
          lines.slice(0, MAX_MATCHES).join("\n") +
          `\n\n(Results truncated at ${MAX_MATCHES} matches.)`;
      }

      return { content: output || "No matches found." };
    } catch (err) {
      return {
        content: `Error searching: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
