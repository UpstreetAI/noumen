import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
export type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Configuration for MCP server OAuth authentication.
 * When provided on an HTTP or SSE server config, noumen will automatically
 * create an OAuthClientProvider and wire it into the transport.
 */
export interface McpOAuthConfig {
  /** Pre-registered client ID. Omit to use Dynamic Client Registration. */
  clientId?: string;
  /** Client secret for confidential clients. */
  clientSecret?: string;
  /** Space-separated OAuth scopes to request. */
  scopes?: string;
  /** Preferred local port for the OAuth callback server. */
  callbackPort?: number;
  /** Override URL for the authorization server metadata endpoint. */
  authServerMetadataUrl?: string;
}

/**
 * Persisted state for a single MCP server's OAuth session.
 */
export interface OAuthTokenData {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  /** Epoch ms when the access token expires (computed from tokens.expires_in). */
  expiresAt?: number;
}

/**
 * Pluggable storage backend for OAuth tokens and session data.
 * Consumers provide their own implementation (file, keychain, database, etc).
 */
export interface TokenStorage {
  load(serverKey: string): Promise<OAuthTokenData | undefined>;
  save(serverKey: string, data: OAuthTokenData): Promise<void>;
  delete(serverKey: string): Promise<void>;
}

/**
 * Options for creating a NoumenOAuthProvider.
 */
export interface OAuthProviderOptions {
  storage: TokenStorage;
  clientMetadata: OAuthClientMetadata;
  /** Pre-registered client ID (skips Dynamic Client Registration). */
  clientId?: string;
  /** Client secret for confidential clients. */
  clientSecret?: string;
  /** Preferred local port for the callback server. */
  callbackPort?: number;
  /**
   * Called when the user must visit an authorization URL.
   * If not provided, the default behavior opens the system browser.
   */
  onAuthorizationUrl?: (url: string) => void | Promise<void>;
  /** AbortSignal to cancel in-progress authorization flows. */
  signal?: AbortSignal;
}
