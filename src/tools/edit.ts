import * as nodePath from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";
import { findActualString, preserveQuoteStyle } from "./edit-utils.js";
import { EDIT_PROMPT } from "./prompts/edit.js";
import { isDangerousPath } from "../permissions/pipeline.js";

export const editFileTool: Tool = {
  name: "EditFile",
  description:
    "Edit a file by replacing an exact string match with new content. " +
    "The old_string must match exactly (including whitespace and indentation). " +
    "Set replace_all to true to replace all occurrences.",
  prompt: EDIT_PROMPT,
  isReadOnly: false,
  checkPermissions(args, ctx) {
    const filePath = args.file_path as string;
    if (isDangerousPath(filePath, ctx.cwd)) {
      return {
        behavior: "ask" as const,
        message: `Edit targets sensitive path: ${filePath}`,
        reason: "safetyCheck",
      };
    }
    return {
      behavior: "passthrough" as const,
      message: `Edit ${filePath}`,
    };
  },
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path of the file to edit",
      },
      old_string: {
        type: "string",
        description: "The exact string to find and replace",
      },
      new_string: {
        type: "string",
        description: "The replacement string",
      },
      replace_all: {
        type: "boolean",
        description:
          "If true, replace all occurrences of old_string. Defaults to false.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },

  async call(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const filePath = args.file_path as string;
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = (args.replace_all as boolean) ?? false;

    if (filePath.endsWith(".ipynb")) {
      return {
        content: `Error: ${filePath} is a Jupyter Notebook. Use the NotebookEdit tool to edit notebook files.`,
        isError: true,
      };
    }

    if (oldString === newString) {
      return {
        content: "No changes to make: old_string and new_string are exactly the same.",
        isError: true,
      };
    }

    if (oldString === "") {
      const exists = await ctx.fs.exists(filePath);
      if (!exists) {
        if (ctx.checkpointManager && ctx.currentMessageId) {
          await ctx.checkpointManager.trackEdit(filePath, ctx.currentMessageId, ctx.sessionId ?? "");
        }
        await ctx.fs.writeFile(filePath, newString);
        ctx.notifyHook?.("FileWrite", {
          event: "FileWrite", sessionId: ctx.sessionId ?? "",
          toolName: "EditFile", filePath, isNew: true,
        }).catch(() => {});
        if (ctx.fileStateCache) {
          ctx.fileStateCache.set(filePath, { content: newString, timestamp: Date.now() });
        }
        return { content: `Created new file ${filePath}.` };
      }
      const existing = await ctx.fs.readFile(filePath);
      if (existing.trim() !== "") {
        return {
          content: "Error: old_string is empty but file already has content. Use WriteFile to overwrite, or provide the exact text to replace.",
          isError: true,
        };
      }
      await ctx.fs.writeFile(filePath, newString);
      if (ctx.fileStateCache) {
        ctx.fileStateCache.set(filePath, { content: newString, timestamp: Date.now() });
      }
      return { content: `File ${filePath} has been updated successfully.` };
    }

    const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB

    try {
      // File size guard
      try {
        const stat = await ctx.fs.stat(filePath);
        if (stat.size !== undefined && stat.size > MAX_EDIT_FILE_SIZE) {
          return {
            content: `Error: File is too large to edit (${Math.round(stat.size / 1024 / 1024)} MiB). Max: 1 GiB.`,
            isError: true,
          };
        }
      } catch {
        // stat failure — file might not exist, which is fine for creation
      }

      // Read-before-edit enforcement
      if (ctx.fileStateCache) {
        const cached = ctx.fileStateCache.get(filePath);
        if (!cached || cached.isPartialView) {
          return {
            content: `Error: File has not been read yet. Use ReadFile on ${filePath} before editing.`,
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
                content: `Error: ${filePath} has been modified since last read. Re-read the file before editing.`,
                isError: true,
              };
            }
          }
        } catch {
          // stat/read failure — proceed anyway, the writeFile will catch real issues
        }
      }

      if (ctx.checkpointManager && ctx.currentMessageId) {
        await ctx.checkpointManager.trackEdit(filePath, ctx.currentMessageId, ctx.sessionId ?? "");
      }

      const content = await ctx.fs.readFile(filePath);

      // Fuzzy matching: try exact match first, then quote-normalized match
      const actualOldString = findActualString(content, oldString);
      if (!actualOldString) {
        return {
          content: `Error: old_string not found in ${filePath}. Make sure the string matches exactly, including whitespace and indentation.`,
          isError: true,
        };
      }

      if (!replaceAll) {
        const count = content.split(actualOldString).length - 1;
        if (count > 1) {
          return {
            content: `Error: old_string appears ${count} times in ${filePath}. Provide more context to make it unique, or set replace_all to true.`,
            isError: true,
          };
        }
      }

      // Preserve the file's quote style in the replacement text
      const actualNewString = preserveQuoteStyle(oldString, actualOldString, newString);

      let updated: string;
      if (replaceAll) {
        updated = content.split(actualOldString).join(actualNewString);
      } else if (actualNewString === "") {
        const hasTrailingNewline =
          !actualOldString.endsWith("\n") &&
          content.includes(actualOldString + "\n");
        const deleteTarget = hasTrailingNewline
          ? actualOldString + "\n"
          : actualOldString;
        updated = content.replace(deleteTarget, () => actualNewString);
      } else {
        updated = content.replace(actualOldString, () => actualNewString);
      }

      const dir = nodePath.dirname(filePath);
      if (dir && dir !== "." && dir !== "/") {
        await ctx.fs.mkdir(dir, { recursive: true }).catch(() => {});
      }
      await ctx.fs.writeFile(filePath, updated);

      ctx.notifyHook?.("FileWrite", {
        event: "FileWrite",
        sessionId: ctx.sessionId ?? "",
        toolName: "EditFile",
        filePath,
        isNew: false,
      }).catch(() => {});

      // Update cache with the full post-edit content
      if (ctx.fileStateCache) {
        let mtime = 0;
        try {
          const stat = await ctx.fs.stat(filePath);
          mtime = stat.modifiedAt ? Math.floor(stat.modifiedAt.getTime()) : 0;
        } catch {
          // best-effort
        }
        ctx.fileStateCache.set(filePath, {
          content: updated,
          timestamp: mtime,
        });
      }

      return {
        content: `File ${filePath} has been updated successfully.`,
      };
    } catch (err) {
      return {
        content: `Error editing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
