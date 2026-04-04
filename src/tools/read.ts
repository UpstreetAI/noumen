import type { Tool, ToolResult, ToolContext } from "./types.js";

export const readFileTool: Tool = {
  name: "ReadFile",
  description:
    "Read a file from the filesystem. Returns the file content with line numbers. " +
    "Use offset and limit to read specific portions of large files.",
  isReadOnly: true,
  isConcurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path of the file to read (absolute or relative to cwd)",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed). Defaults to 1.",
        minimum: 1,
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read. If omitted, reads entire file.",
        minimum: 1,
      },
    },
    required: ["file_path"],
  },

  async call(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const filePath = args.file_path as string;
    const offset = (args.offset as number | undefined) ?? 1;
    const limit = args.limit as number | undefined;

    try {
      const content = await ctx.fs.readFile(filePath);
      const lines = content.split("\n");

      const startIdx = Math.max(0, offset - 1);
      const endIdx = limit ? Math.min(lines.length, startIdx + limit) : lines.length;
      const selectedLines = lines.slice(startIdx, endIdx);

      const numbered = selectedLines.map(
        (line, i) => `${String(startIdx + i + 1).padStart(6)}|${line}`,
      );

      let result = numbered.join("\n");
      if (endIdx < lines.length) {
        result += `\n... ${lines.length - endIdx} lines not shown ...`;
      }

      return { content: result || "File is empty." };
    } catch (err) {
      return {
        content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
