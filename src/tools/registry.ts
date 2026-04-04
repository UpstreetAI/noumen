import type { Tool, ToolContext } from "./types.js";
import type { ToolDefinition } from "../providers/types.js";
import { formatZodValidationError } from "../utils/zod.js";
import { isDeferredTool } from "./tool-search.js";
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
  private _discoveredTools = new Set<string>();
  private _toolSearchEnabled = false;

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

  enableToolSearch(): void {
    this._toolSearchEnabled = true;
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
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

    if (tool.inputSchema) {
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: formatZodValidationError(name, parsed.error),
          isError: true,
        };
      }
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

  /**
   * Get tool definitions filtered by tool search. Eager tools (always sent)
   * plus any deferred tools the model has discovered via ToolSearch.
   * Falls back to all tools when tool search is not enabled.
   */
  getActiveToolDefinitions(): ToolDefinition[] {
    if (!this._toolSearchEnabled) return this.toToolDefinitions();

    return Array.from(this.tools.values())
      .filter((tool) => !isDeferredTool(tool) || this._discoveredTools.has(tool.name))
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
  }

  getEagerTools(): Tool[] {
    return Array.from(this.tools.values()).filter((tool) => !isDeferredTool(tool));
  }

  getDeferredTools(): Tool[] {
    return Array.from(this.tools.values()).filter(isDeferredTool);
  }

  getToolsByNames(names: string[]): Tool[] {
    return names
      .map((name) => this.tools.get(name))
      .filter((t): t is Tool => t !== undefined);
  }

  markDiscovered(names: string[]): void {
    for (const name of names) {
      this._discoveredTools.add(name);
    }
  }

  get discoveredTools(): ReadonlySet<string> {
    return this._discoveredTools;
  }

  listTools(): Tool[] {
    return Array.from(this.tools.values());
  }
}
