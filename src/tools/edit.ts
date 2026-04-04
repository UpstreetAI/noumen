import type { Tool, ToolResult, ToolContext } from "./types.js";

export const editFileTool: Tool = {
  name: "EditFile",
  description:
    "Edit a file by replacing an exact string match with new content. " +
    "The old_string must match exactly (including whitespace and indentation). " +
    "Set replace_all to true to replace all occurrences.",
  isReadOnly: false,
  checkPermissions(args) {
    const filePath = args.file_path as string;
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

    try {
      const content = await ctx.fs.readFile(filePath);

      if (!content.includes(oldString)) {
        return {
          content: `Error: old_string not found in ${filePath}. Make sure the string matches exactly, including whitespace and indentation.`,
          isError: true,
        };
      }

      if (!replaceAll) {
        const count = content.split(oldString).length - 1;
        if (count > 1) {
          return {
            content: `Error: old_string appears ${count} times in ${filePath}. Provide more context to make it unique, or set replace_all to true.`,
            isError: true,
          };
        }
      }

      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      await ctx.fs.writeFile(filePath, updated);

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
