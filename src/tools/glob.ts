import type { Tool, ToolResult, ToolContext } from "./types.js";
import { GLOB_PROMPT } from "./prompts/glob.js";
import { shellEscape } from "../utils/shell-escape.js";

const MAX_RESULTS = 200;

export const globTool: Tool = {
  name: "Glob",
  description:
    "Find files matching a glob pattern. Uses ripgrep (rg --files --glob) " +
    "for fast, gitignore-aware file discovery. Returns matching file paths " +
    "sorted by modification time.",
  prompt: GLOB_PROMPT,
  isReadOnly: true,
  isConcurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          'Glob pattern to match files (e.g. "*.ts", "src/**/*.tsx")',
      },
      path: {
        type: "string",
        description: "Directory to search in (defaults to cwd)",
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

    const fullPattern = pattern.startsWith("**/")
      ? pattern
      : `**/${pattern}`;

    const resolvedPath = searchPath === ctx.cwd ? "." : searchPath;
    const command = `rg --files --hidden --glob ${shellEscape(fullPattern)} --sortr=modified ${shellEscape(resolvedPath)} | head -n ${String(MAX_RESULTS + 1)}`;

    try {
      let result = await ctx.computer.executeCommand(command, {
        cwd: ctx.cwd,
      });

      // rg not installed — fall back to find(1) which is universally available
      if (result.exitCode === 127 || result.stderr?.includes("not found")) {
        const findCommand = `find ${shellEscape(resolvedPath)} -name ${shellEscape(pattern)} -type f | head -n ${String(MAX_RESULTS + 1)}`;
        result = await ctx.computer.executeCommand(findCommand, {
          cwd: ctx.cwd,
        });
      }

      // rg exits with 1 when no matches; exit > 1 is a real error
      if (result.exitCode > 1) {
        return {
          content: `Glob error: ${result.stderr || result.stdout}`,
          isError: true,
        };
      }

      const lines = result.stdout
        .split("\n")
        .filter((l) => l.trim() !== "");

      if (lines.length === 0) {
        return { content: "No files found matching the pattern." };
      }

      const truncated = lines.length > MAX_RESULTS;
      const files = truncated ? lines.slice(0, MAX_RESULTS) : lines;

      let output = files.join("\n");
      if (truncated) {
        output += `\n\n(Results truncated. More than ${MAX_RESULTS} files match.)`;
      }

      return { content: output };
    } catch (err) {
      return {
        content: `Error searching files: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
