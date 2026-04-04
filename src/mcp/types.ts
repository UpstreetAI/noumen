import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpOAuthConfig } from "./auth/types.js";

export type { McpOAuthConfig } from "./auth/types.js";

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
  /** OAuth configuration — noumen creates an auth provider automatically. */
  oauth?: McpOAuthConfig;
  /** Fully custom OAuthClientProvider — overrides `oauth` config when set. */
  authProvider?: OAuthClientProvider;
}

export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  /** OAuth configuration — noumen creates an auth provider automatically. */
  oauth?: McpOAuthConfig;
  /** Fully custom OAuthClientProvider — overrides `oauth` config when set. */
  authProvider?: OAuthClientProvider;
}

export interface McpWebSocketServerConfig {
  type: "websocket";
  url: string;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpSseServerConfig
  | McpWebSocketServerConfig;

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

// --- Connection state ---

export interface McpConnection {
  name: string;
  client: Client | null;
  status: "connected" | "failed" | "pending" | "needs-auth";
  config: McpServerConfig;
  cleanup: () => Promise<void>;
}

export interface McpToolInfo {
  serverName: string;
  toolName: string;
}
