import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildMcpToolName } from "../mcp/normalization.js";

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

    // Call a non-existent tool
    const result = await client.callTool({
      name: "nonexistent",
      arguments: {},
    });
    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
  });
});
