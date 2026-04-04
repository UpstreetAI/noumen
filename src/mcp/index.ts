export { McpClientManager, type McpClientManagerOptions } from "./client.js";
export type {
  McpServerConfig,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpSseServerConfig,
  McpWebSocketServerConfig,
  McpOAuthConfig,
  McpConfig,
  McpConnection,
  McpToolInfo,
} from "./types.js";
export { createMcpServer, type McpServerOptions } from "./server.js";
export {
  normalizeNameForMCP,
  buildMcpToolName,
  getMcpPrefix,
  parseMcpToolName,
} from "./normalization.js";

// MCP OAuth
export type {
  TokenStorage,
  OAuthTokenData,
  OAuthProviderOptions,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
} from "./auth/types.js";
export { InMemoryTokenStorage, FileTokenStorage } from "./auth/storage.js";
export {
  findAvailablePort,
  OAuthCallbackServer,
  type OAuthCallbackResult,
} from "./auth/callback-server.js";
export { NoumenOAuthProvider } from "./auth/provider.js";
export { createMcpAuthTool } from "../tools/mcp-auth.js";
