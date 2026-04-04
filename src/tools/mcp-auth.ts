import type { Tool, ToolResult, ToolContext } from "./types.js";
import type { McpClientManager } from "../mcp/client.js";
import { buildMcpToolName } from "../mcp/normalization.js";

/**
 * Create an MCP authenticate tool for a specific server that requires OAuth.
 * The agent calls this tool to trigger interactive authentication, then the
 * server is reconnected and its tools become available.
 */
export function createMcpAuthTool(
  serverName: string,
  mcpManager: McpClientManager,
): Tool {
  const toolName = buildMcpToolName(serverName, "authenticate");

  return {
    name: toolName,
    description:
      `Authenticate with the MCP server "${serverName}". ` +
      "Call this tool when the server requires OAuth authentication " +
      "before its tools can be used. Returns an authorization URL for " +
      "the user to visit, or confirms that authentication succeeded.",
    isReadOnly: true,
    isConcurrencySafe: false,
    parameters: {
      type: "object",
      properties: {},
    },

    async call(
      _args: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolResult> {
      try {
        const result = await mcpManager.performAuth(serverName);

        if (result.authUrl) {
          return {
            content:
              `Authentication required for MCP server "${serverName}". ` +
              `Please visit: ${result.authUrl}\n\n` +
              "After authorizing, the server will be reconnected automatically.",
          };
        }

        return {
          content:
            `Successfully authenticated with MCP server "${serverName}". ` +
            "Its tools are now available.",
        };
      } catch (err) {
        return {
          content:
            `Failed to authenticate with MCP server "${serverName}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
