import type { Tool, ToolResult, ToolContext } from "./types.js";

export const writeFileTool: Tool = {
  name: "WriteFile",
  description:
    "Create or overwrite a file with the given content. " +
    "Parent directories are created automatically if they don't exist.",
  isReadOnly: false,
  checkPermissions(args) {
    const filePath = args.file_path as string;
    return {
      behavior: "passthrough" as const,
      message: `Write to ${filePath}`,
    };
  },
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path of the file to write (absolute or relative to cwd)",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },

  async call(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const filePath = args.file_path as string;
    const content = args.content as string;

    try {
      if (ctx.checkpointManager && ctx.currentMessageId) {
        await ctx.checkpointManager.trackEdit(filePath, ctx.currentMessageId, ctx.sessionId ?? "");
      }

      const existed = await ctx.fs.exists(filePath);
      await ctx.fs.writeFile(filePath, content);

      // Update file state cache with the written content
      if (ctx.fileStateCache) {
        let mtime = 0;
        try {
          const stat = await ctx.fs.stat(filePath);
          mtime = stat.modifiedAt ? Math.floor(stat.modifiedAt.getTime()) : 0;
        } catch {
          // best-effort
        }
        ctx.fileStateCache.set(filePath, {
          content,
          timestamp: mtime,
        });
      }

      return {
        content: existed
          ? `File updated successfully at: ${filePath}`
          : `File created successfully at: ${filePath}`,
      };
    } catch (err) {
      return {
        content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
