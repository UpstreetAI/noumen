import * as nodePath from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";
import { WRITE_PROMPT } from "./prompts/write.js";
import { isDangerousPath } from "../permissions/pipeline.js";
import { withFileLock } from "./file-lock.js";

export const writeFileTool: Tool = {
  name: "WriteFile",
  description:
    "Create or overwrite a file with the given content. " +
    "Parent directories are created automatically if they don't exist.",
  prompt: WRITE_PROMPT,
  isReadOnly: false,
  checkPermissions(args, ctx) {
    const filePath = args.file_path as string;
    if (filePath.startsWith("\\\\") || filePath.startsWith("//")) {
      return {
        behavior: "deny" as const,
        message: "Error: UNC paths are not allowed",
      };
    }
    if (isDangerousPath(filePath, ctx.cwd, ctx.dotDirResolver?.config.names)) {
      return {
        behavior: "ask" as const,
        message: `Write targets sensitive path: ${filePath}`,
        reason: "safetyCheck",
      };
    }
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

      if (existed && ctx.fileStateCache) {
        const cached = ctx.fileStateCache.get(filePath);
        if (!cached) {
          return {
            content: `Error: File ${filePath} exists but has not been read yet. Read it first before overwriting.`,
            isError: true,
          };
        }
        try {
          const stat = await ctx.fs.stat(filePath);
          const mtime = stat.modifiedAt ? Math.floor(stat.modifiedAt.getTime()) : 0;
          if (mtime > cached.timestamp) {
            const currentContent = await ctx.fs.readFile(filePath);
            if (currentContent !== cached.content) {
              return {
                content: `Error: ${filePath} has been modified since last read. Re-read the file before overwriting.`,
                isError: true,
              };
            }
          }
        } catch {
          // stat/read failure — proceed, writeFile will catch real issues
        }
      }

      const dir = nodePath.dirname(filePath);
      if (dir && dir !== "." && dir !== "/") {
        await ctx.fs.mkdir(dir, { recursive: true }).catch(() => {});
      }

      // Hold a per-file lock for the write to prevent TOCTOU races when
      // concurrent writes target the same path.
      await withFileLock(filePath, async () => {
        await ctx.fs.writeFile(filePath, content);
      });

      ctx.notifyHook?.("FileWrite", {
        event: "FileWrite",
        sessionId: ctx.sessionId ?? "",
        toolName: "WriteFile",
        filePath,
        isNew: !existed,
      }).catch(() => {});

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
