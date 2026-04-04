import type { Tool, ToolContext } from "./types.js";
import type { ToolDefinition } from "../providers/types.js";
import { readFileTool } from "./read.js";
import { writeFileTool } from "./write.js";
import { editFileTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webFetchTool } from "./web-fetch.js";
import { notebookEditTool } from "./notebook.js";
import { askUserTool } from "./ask-user.js";

/**
 * Resolve a tool flag that can be a static boolean or a function of the input.
 * Returns `defaultValue` when the flag is `undefined`.
 */
export function resolveToolFlag(
  flag: boolean | ((args: Record<string, unknown>) => boolean) | undefined,
  args: Record<string, unknown>,
  defaultValue = false,
): boolean {
  if (flag === undefined) return defaultValue;
  if (typeof flag === "function") return flag(args);
  return flag;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor(additionalTools?: Tool[]) {
    const builtIn = [
      readFileTool,
      writeFileTool,
      editFileTool,
      bashTool,
      globTool,
      grepTool,
      webFetchTool,
      notebookEditTool,
      askUserTool,
    ];

    for (const tool of builtIn) {
      this.tools.set(tool.name, tool);
    }

    if (additionalTools) {
      for (const tool of additionalTools) {
        this.tools.set(tool.name, tool);
      }
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ content: string; isError?: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `Unknown tool: ${name}`,
        isError: true,
      };
    }
    return tool.call(args, ctx);
  }

  toToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  listTools(): Tool[] {
    return Array.from(this.tools.values());
  }
}
