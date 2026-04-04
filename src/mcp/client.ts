import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool as McpSdkTool } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolResult } from "../tools/types.js";
import type { ContentPart } from "../session/types.js";
import { maybeResizeAndDownsampleImageBuffer } from "../utils/image-resizer.js";
import type {
  McpServerConfig,
  McpHttpServerConfig,
  McpSseServerConfig,
  McpConnection,
  McpToolInfo,
} from "./types.js";
import type { TokenStorage, McpOAuthConfig } from "./auth/types.js";
import { NoumenOAuthProvider } from "./auth/provider.js";
import { findAvailablePort } from "./auth/callback-server.js";
import { InMemoryTokenStorage } from "./auth/storage.js";
import { buildMcpToolName } from "./normalization.js";

export interface McpClientManagerOptions {
  /**
   * Default token storage used for servers that declare `oauth` config
   * but no custom `authProvider`. Falls back to InMemoryTokenStorage.
   */
  tokenStorage?: TokenStorage;
  /**
   * Called when a server requires interactive OAuth and the user must
   * visit an authorization URL. Passed through to NoumenOAuthProvider.
   */
  onAuthorizationUrl?: (url: string) => void | Promise<void>;
}

export class McpClientManager {
  private connections: Map<string, McpConnection> = new Map();
  private serverConfigs: Record<string, McpServerConfig>;
  private tokenStorage: TokenStorage;
  private onAuthorizationUrl?: (url: string) => void | Promise<void>;

  constructor(
    mcpServers: Record<string, McpServerConfig>,
    options?: McpClientManagerOptions,
  ) {
    this.serverConfigs = mcpServers;
    this.tokenStorage = options?.tokenStorage ?? new InMemoryTokenStorage();
    this.onAuthorizationUrl = options?.onAuthorizationUrl;
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
    let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | WebSocketClientTransport;
    let cleanup: () => Promise<void>;

    const configType = "type" in config ? config.type : "stdio";

    switch (configType) {
      case "http": {
        const httpConfig = config as McpHttpServerConfig;
        const url = new URL(httpConfig.url);
        const authProvider = await this.resolveAuthProvider(name, httpConfig);
        transport = new StreamableHTTPClientTransport(url, {
          authProvider: authProvider ?? undefined,
          requestInit: httpConfig.headers
            ? { headers: httpConfig.headers }
            : undefined,
        });
        cleanup = async () => { await transport.close(); };
        break;
      }

      case "sse": {
        const sseConfig = config as McpSseServerConfig;
        const url = new URL(sseConfig.url);
        const authProvider = await this.resolveAuthProvider(name, sseConfig);
        transport = new SSEClientTransport(url, {
          authProvider: authProvider ?? undefined,
          requestInit: sseConfig.headers
            ? { headers: sseConfig.headers }
            : undefined,
        });
        cleanup = async () => { await transport.close(); };
        break;
      }

      case "websocket": {
        const wsConfig = config as { url: string };
        const url = new URL(wsConfig.url);
        transport = new WebSocketClientTransport(url);
        cleanup = async () => { await transport.close(); };
        break;
      }

      default: {
        const stdioConfig = config as {
          command: string;
          args?: string[];
          env?: Record<string, string>;
        };
        transport = new StdioClientTransport({
          command: stdioConfig.command,
          args: stdioConfig.args,
          env: stdioConfig.env
            ? ({ ...process.env, ...stdioConfig.env } as Record<string, string>)
            : undefined,
        });
        cleanup = async () => { await transport.close(); };
        break;
      }
    }

    try {
      await client.connect(transport);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        this.connections.set(name, {
          name,
          client,
          status: "needs-auth",
          config,
          cleanup,
        });
        return;
      }
      throw err;
    }

    this.connections.set(name, {
      name,
      client,
      status: "connected",
      config,
      cleanup,
    });
  }

  /**
   * Resolve an OAuthClientProvider for an HTTP or SSE server config.
   * Returns null if the server doesn't require authentication.
   */
  private async resolveAuthProvider(
    serverName: string,
    config: McpHttpServerConfig | McpSseServerConfig,
  ): Promise<OAuthClientProvider | null> {
    if (config.authProvider) return config.authProvider;
    if (!config.oauth) return null;

    const oauth = config.oauth;
    const serverKey = `${serverName}|${config.url}`;
    const port = await findAvailablePort(oauth.callbackPort);

    return new NoumenOAuthProvider(serverKey, {
      storage: this.tokenStorage,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      callbackPort: port,
      onAuthorizationUrl: this.onAuthorizationUrl,
      clientMetadata: {
        redirect_uris: [`http://localhost:${port}/callback`],
        client_name: `noumen-${serverName}`,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: oauth.scopes,
      },
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

      const contentBlocks = result.content as Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
        blob?: string;
      }> | undefined;

      if (!contentBlocks) {
        return { content: JSON.stringify(result), isError: result.isError === true };
      }

      const parts: ContentPart[] = [];
      for (const block of contentBlocks) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text ?? "" });
        } else if (block.type === "image" && block.data) {
          const imageBuffer = Buffer.from(block.data, "base64");
          const ext = block.mimeType?.split("/")[1] || "png";
          try {
            const resized = await maybeResizeAndDownsampleImageBuffer(
              imageBuffer,
              imageBuffer.length,
              ext,
            );
            parts.push({
              type: "image",
              data: resized.buffer.toString("base64"),
              media_type: `image/${resized.mediaType}`,
            });
          } catch {
            parts.push({
              type: "image",
              data: block.data,
              media_type: block.mimeType ?? "image/png",
            });
          }
        } else if (block.type === "resource" && block.blob) {
          const isImage = block.mimeType?.startsWith("image/") ?? false;
          if (isImage) {
            const imageBuffer = Buffer.from(block.blob, "base64");
            const ext = block.mimeType?.split("/")[1] || "png";
            try {
              const resized = await maybeResizeAndDownsampleImageBuffer(
                imageBuffer,
                imageBuffer.length,
                ext,
              );
              parts.push({
                type: "image",
                data: resized.buffer.toString("base64"),
                media_type: `image/${resized.mediaType}`,
              });
            } catch {
              parts.push({
                type: "image",
                data: block.blob,
                media_type: block.mimeType ?? "image/png",
              });
            }
          } else {
            parts.push({ type: "text", text: JSON.stringify(block) });
          }
        } else {
          parts.push({ type: "text", text: JSON.stringify(block) });
        }
      }

      // If all parts are text, flatten to a single string for simpler downstream handling
      if (parts.every((p) => p.type === "text")) {
        const text = parts
          .map((p) => (p as { text: string }).text)
          .join("\n");
        return { content: text, isError: result.isError === true };
      }

      return { content: parts, isError: result.isError === true };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  getConnectionStatus(): Array<{
    name: string;
    status: string;
    toolCount?: number;
  }> {
    return Array.from(this.connections.values()).map((c) => ({
      name: c.name,
      status: c.status,
    }));
  }

  /**
   * Returns server names that are in `needs-auth` status and require
   * interactive OAuth before they can be used.
   */
  getServersNeedingAuth(): string[] {
    return Array.from(this.connections.entries())
      .filter(([, conn]) => conn.status === "needs-auth")
      .map(([name]) => name);
  }

  /**
   * Reconnect a server by closing its existing connection and
   * establishing a new one. Useful after completing OAuth.
   */
  async reconnect(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (conn) {
      await conn.cleanup().catch(() => {});
      this.connections.delete(serverName);
    }

    const config = this.serverConfigs[serverName];
    if (!config) return;

    try {
      await this.connectToServer(serverName, config);
    } catch {
      this.connections.set(serverName, {
        name: serverName,
        client: null as unknown as Client,
        status: "failed",
        config,
        cleanup: async () => {},
      });
    }
  }

  /**
   * Trigger interactive OAuth for a `needs-auth` server, then reconnect.
   * Runs the full MCP SDK auth orchestrator with a local callback server.
   *
   * Returns the authorization URL if the flow requires user interaction,
   * or null if the server connected without browser auth (e.g. cached tokens).
   */
  async performAuth(
    serverName: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ authUrl?: string }> {
    const config = this.serverConfigs[serverName];
    if (!config) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }

    const configType = "type" in config ? config.type : "stdio";
    if (configType !== "http" && configType !== "sse") {
      throw new Error(
        `OAuth is only supported for HTTP and SSE transports, got: ${configType}`,
      );
    }

    const httpConfig = config as McpHttpServerConfig | McpSseServerConfig;
    if (!httpConfig.oauth && !httpConfig.authProvider) {
      throw new Error(
        `Server "${serverName}" has no OAuth configuration`,
      );
    }

    let capturedAuthUrl: string | undefined;
    const originalCallback = this.onAuthorizationUrl;

    this.onAuthorizationUrl = async (url: string) => {
      capturedAuthUrl = url;
      if (originalCallback) await originalCallback(url);
    };

    try {
      await this.reconnect(serverName);
    } finally {
      this.onAuthorizationUrl = originalCallback;
    }

    return { authUrl: capturedAuthUrl };
  }

  async close(): Promise<void> {
    const cleanups = Array.from(this.connections.values()).map((c) =>
      c.cleanup().catch(() => {}),
    );
    await Promise.all(cleanups);
    this.connections.clear();
  }
}
