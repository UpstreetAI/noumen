import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool as McpSdkTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { contentToString } from "../utils/content.js";

export interface McpServerOptions {
  /** Additional tools beyond the 6 built-ins */
  tools?: Tool[];
  /** Context passed to tool.call() for all invocations */
  toolContext: ToolContext;
  /** Server name reported to clients */
  name?: string;
  /** Server version reported to clients */
  version?: string;
}

/**
 * Start an MCP server over stdio that exposes noumen's tools.
 * This is the entry point for `noumen mcp` or similar CLI integrations.
 */
export async function createMcpServer(opts: McpServerOptions): Promise<void> {
  const registry = new ToolRegistry(opts.tools);

  const server = new Server(
    { name: opts.name ?? "noumen", version: opts.version ?? "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => {
      const tools = registry.listTools();
      return {
        tools: tools.map(
          (tool): McpSdkTool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: {
              type: "object" as const,
              properties: tool.parameters.properties as Record<string, object>,
              ...(tool.parameters.required
                ? { required: tool.parameters.required }
                : {}),
            },
          }),
        ),
      };
    },
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }): Promise<CallToolResult> => {
      const tool = registry.get(name);
      if (!tool) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
      }

      try {
        const result = await tool.call(
          (args as Record<string, unknown>) ?? {},
          opts.toolContext,
        );
        return {
          isError: result.isError,
          content: [{ type: "text", text: contentToString(result.content) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: message }],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
