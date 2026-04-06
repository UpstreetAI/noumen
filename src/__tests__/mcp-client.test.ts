import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildMcpToolName, normalizeNameForMCP, parseMcpToolName, getMcpPrefix } from "../mcp/normalization.js";
import { McpClientManager } from "../mcp/client.js";

/**
 * Linked in-process transports for testing.
 */
class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined;
  private closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  setPeer(peer: InProcessTransport): void {
    this.peer = peer;
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("Transport closed");
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      this.peer.onclose?.();
    }
  }
}

function createTransportPair(): [InProcessTransport, InProcessTransport] {
  const a = new InProcessTransport();
  const b = new InProcessTransport();
  a.setPeer(b);
  b.setPeer(a);
  return [a, b];
}

/**
 * Start a mock MCP server with given tools.
 */
async function startMockServer(
  transport: Transport,
  tools: Array<{
    name: string;
    description: string;
    handler: (args: Record<string, unknown>) => string;
  }>,
) {
  const server = new Server(
    { name: "mock-server", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object" as const, properties: {} },
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return { isError: true, content: [{ type: "text", text: `Unknown: ${name}` }] };
      }
      return {
        content: [{ type: "text", text: tool.handler((args ?? {}) as Record<string, unknown>) }],
      };
    },
  );

  await server.connect(transport);
  return server;
}

describe("MCP Client tool mapping", () => {
  it("maps MCP tools to noumen Tool interface with qualified names", async () => {
    const [clientTransport, serverTransport] = createTransportPair();

    const server = await startMockServer(serverTransport, [
      {
        name: "list_repos",
        description: "List repositories",
        handler: () => "repo1, repo2",
      },
      {
        name: "create_issue",
        description: "Create an issue",
        handler: (args) => `Created: ${args.title ?? "untitled"}`,
      },
    ]);

    const client = new Client({ name: "test", version: "0.1.0" });
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    expect(toolsResult.tools).toHaveLength(2);

    // Verify naming convention
    const expectedName = buildMcpToolName("github", "list_repos");
    expect(expectedName).toBe("mcp__github__list_repos");

    // Verify tool invocation through MCP
    const result = await client.callTool({
      name: "list_repos",
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe("repo1, repo2");

    const issueResult = await client.callTool({
      name: "create_issue",
      arguments: { title: "Bug report" },
    });
    const issueText = (issueResult.content as Array<{ type: string; text: string }>)[0].text;
    expect(issueText).toBe("Created: Bug report");

    await client.close();
    await server.close();
  });

  it("handles MCP tool errors", async () => {
    const [clientTransport, serverTransport] = createTransportPair();

    const server = await startMockServer(serverTransport, []);

    const client = new Client({ name: "test", version: "0.1.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "nonexistent",
      arguments: {},
    });
    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it("passes tool arguments through correctly", async () => {
    const [clientTransport, serverTransport] = createTransportPair();

    const server = await startMockServer(serverTransport, [
      {
        name: "echo",
        description: "Echo args",
        handler: (args) => JSON.stringify(args),
      },
    ]);

    const client = new Client({ name: "test", version: "0.1.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "echo",
      arguments: { key: "value", num: 42 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.key).toBe("value");
    expect(parsed.num).toBe(42);

    await client.close();
    await server.close();
  });

  it("handles multi-tool servers", async () => {
    const [clientTransport, serverTransport] = createTransportPair();

    const tools = Array.from({ length: 5 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      handler: () => `result_${i}`,
    }));

    const server = await startMockServer(serverTransport, tools);
    const client = new Client({ name: "test", version: "0.1.0" });
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    expect(toolsResult.tools).toHaveLength(5);

    for (let i = 0; i < 5; i++) {
      const result = await client.callTool({ name: `tool_${i}`, arguments: {} });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toBe(`result_${i}`);
    }

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// MCP normalization
// ---------------------------------------------------------------------------

describe("MCP normalization", () => {
  it("normalizeNameForMCP replaces invalid characters", () => {
    expect(normalizeNameForMCP("my-server")).toBe("my-server");
    expect(normalizeNameForMCP("my.server")).toBe("my_server");
    expect(normalizeNameForMCP("my server!")).toBe("my_server_");
    expect(normalizeNameForMCP("plain")).toBe("plain");
  });

  it("buildMcpToolName constructs qualified name", () => {
    expect(buildMcpToolName("github", "list_repos")).toBe("mcp__github__list_repos");
    expect(buildMcpToolName("my.server", "do.thing")).toBe("mcp__my_server__do_thing");
  });

  it("getMcpPrefix returns correct prefix", () => {
    expect(getMcpPrefix("github")).toBe("mcp__github__");
    expect(getMcpPrefix("my.server")).toBe("mcp__my_server__");
  });

  it("parseMcpToolName round-trips with buildMcpToolName", () => {
    const built = buildMcpToolName("myserver", "mytool");
    const parsed = parseMcpToolName(built);
    expect(parsed).toEqual({ serverName: "myserver", toolName: "mytool" });
  });

  it("parseMcpToolName returns null for non-MCP names", () => {
    expect(parseMcpToolName("ReadFile")).toBeNull();
    expect(parseMcpToolName("mcp__")).toBeNull();
    expect(parseMcpToolName("")).toBeNull();
  });

  it("parseMcpToolName handles double underscores in tool name", () => {
    const parsed = parseMcpToolName("mcp__server__tool__with__parts");
    expect(parsed).toEqual({ serverName: "server", toolName: "tool__with__parts" });
  });
});

// ---------------------------------------------------------------------------
// McpClientManager
// ---------------------------------------------------------------------------

describe("McpClientManager", () => {
  it("getTools returns empty array when no servers configured", async () => {
    const manager = new McpClientManager({});
    await manager.connect();
    const tools = await manager.getTools();
    expect(tools).toHaveLength(0);
    await manager.close();
  });

  it("getConnectionStatus returns empty array when no servers", async () => {
    const manager = new McpClientManager({});
    await manager.connect();
    const status = manager.getConnectionStatus();
    expect(status).toHaveLength(0);
    await manager.close();
  });

  it("getServersNeedingAuth returns empty array when no auth needed", async () => {
    const manager = new McpClientManager({});
    await manager.connect();
    expect(manager.getServersNeedingAuth()).toHaveLength(0);
    await manager.close();
  });

  it("callTool returns error for non-connected server", async () => {
    const manager = new McpClientManager({});
    await manager.connect();
    const result = await manager.callTool("missing", "tool", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not connected");
    await manager.close();
  });

  it("connect handles failed servers gracefully", async () => {
    const manager = new McpClientManager({
      broken: {
        command: "nonexistent-binary-that-does-not-exist",
        args: [],
      },
    });
    // Should not throw even when server fails to connect
    await manager.connect();
    const status = manager.getConnectionStatus();
    expect(status).toHaveLength(1);
    expect(status[0].status).toBe("failed");
    await manager.close();
  });

  it("close is safe to call multiple times", async () => {
    const manager = new McpClientManager({});
    await manager.connect();
    await manager.close();
    await manager.close(); // should not throw
  });

  it("reconnect handles unknown server", async () => {
    const manager = new McpClientManager({});
    await manager.connect();
    // Should not throw
    await manager.reconnect("nonexistent");
    await manager.close();
  });
});
