import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpSdkTool } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolResult } from "../tools/types.js";
import type {
  McpServerConfig,
  McpConnection,
  McpToolInfo,
} from "./types.js";
import { buildMcpToolName, normalizeNameForMCP } from "./normalization.js";

export class McpClientManager {
  private connections: Map<string, McpConnection> = new Map();
  private serverConfigs: Record<string, McpServerConfig>;

  constructor(mcpServers: Record<string, McpServerConfig>) {
    this.serverConfigs = mcpServers;
  }

  async connect(): Promise<void> {
    const entries = Object.entries(this.serverConfigs);
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connectToServer(name, config)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const name = entries[i][0];
      if (result.status === "rejected") {
        this.connections.set(name, {
          name,
          client: null as unknown as Client,
          status: "failed",
          config: entries[i][1],
          cleanup: async () => {},
        });
      }
    }
  }

  private async connectToServer(
    name: string,
    config: McpServerConfig,
  ): Promise<void> {
    const client = new Client({ name: `noumen-${name}`, version: "0.1.0" });
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    let cleanup: () => Promise<void>;

    if ("type" in config && config.type === "http") {
      const url = new URL(config.url);
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: config.headers
          ? { headers: config.headers }
          : undefined,
      });
      cleanup = async () => {
        await transport.close();
      };
    } else {
      const stdioConfig = config as { command: string; args?: string[]; env?: Record<string, string> };
      transport = new StdioClientTransport({
        command: stdioConfig.command,
        args: stdioConfig.args,
        env: stdioConfig.env
          ? { ...process.env, ...stdioConfig.env } as Record<string, string>
          : undefined,
      });
      cleanup = async () => {
        await transport.close();
      };
    }

    await client.connect(transport);

    this.connections.set(name, {
      name,
      client,
      status: "connected",
      config,
      cleanup,
    });
  }

  async getTools(): Promise<Tool[]> {
    const tools: Tool[] = [];

    for (const [serverName, conn] of this.connections) {
      if (conn.status !== "connected") continue;

      try {
        const result = await conn.client.listTools();
        for (const mcpTool of result.tools) {
          tools.push(this.mapMcpTool(serverName, mcpTool));
        }
      } catch {
        // Server failed to list tools; skip it
      }
    }

    return tools;
  }

  private mapMcpTool(serverName: string, mcpTool: McpSdkTool): Tool {
    const qualifiedName = buildMcpToolName(serverName, mcpTool.name);

    const parameters = (mcpTool.inputSchema ?? {
      type: "object" as const,
      properties: {},
    }) as Tool["parameters"];

    const mcpInfo: McpToolInfo = {
      serverName,
      toolName: mcpTool.name,
    };

    return {
      name: qualifiedName,
      description: mcpTool.description ?? "",
      parameters,
      mcpInfo,
      call: async (args: Record<string, unknown>): Promise<ToolResult> => {
        return this.callTool(serverName, mcpTool.name, args);
      },
    };
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const conn = this.connections.get(serverName);
    if (!conn || conn.status !== "connected") {
      return {
        content: `MCP server "${serverName}" is not connected`,
        isError: true,
      };
    }

    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: args,
      });

      const content = (result.content as Array<{ type: string; text?: string }>)
        ?.map((c) => (c.type === "text" ? c.text ?? "" : JSON.stringify(c)))
        .join("\n") ?? JSON.stringify(result);

      return {
        content,
        isError: result.isError === true,
      };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  getConnectionStatus(): Array<{ name: string; status: string; toolCount?: number }> {
    return Array.from(this.connections.values()).map((c) => ({
      name: c.name,
      status: c.status,
    }));
  }

  async close(): Promise<void> {
    const cleanups = Array.from(this.connections.values()).map((c) =>
      c.cleanup().catch(() => {}),
    );
    await Promise.all(cleanups);
    this.connections.clear();
  }
}
