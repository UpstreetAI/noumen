import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// --- Server configuration (matching .mcp.json format) ---

export interface McpStdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

// --- Connection state ---

export interface McpConnection {
  name: string;
  client: Client;
  status: "connected" | "failed" | "pending";
  config: McpServerConfig;
  cleanup: () => Promise<void>;
}

export interface McpToolInfo {
  serverName: string;
  toolName: string;
}
