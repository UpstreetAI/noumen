import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { MockFs, MockComputer } from "./helpers.js";

/**
 * Linked in-process transport pair for testing (no subprocess needed).
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

function createTransportPair(): [Transport, Transport] {
  const a = new InProcessTransport();
  const b = new InProcessTransport();
  a.setPeer(b);
  b.setPeer(a);
  return [a, b];
}

function makeToolContext(): ToolContext {
  return {
    fs: new MockFs({ "/test.txt": "hello world" }),
    computer: new MockComputer(),
    cwd: "/",
  };
}

describe("MCP Server (in-process)", () => {
  it("lists all built-in tools", async () => {
    const registry = new ToolRegistry();
    const toolCtx = makeToolContext();

    const [clientTransport, serverTransport] = createTransportPair();

    const server = new Server(
      { name: "noumen-test", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: registry.listTools().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: {
          type: "object" as const,
          properties: t.parameters.properties as Record<string, object>,
        },
      })),
    }));

    server.setRequestHandler(
      CallToolRequestSchema,
      async ({ params: { name, arguments: args } }) => {
        const tool = registry.get(name);
        if (!tool) {
          return { isError: true, content: [{ type: "text", text: `Unknown: ${name}` }] };
        }
        const result = await tool.call((args ?? {}) as Record<string, unknown>, toolCtx);
        return { content: [{ type: "text", text: result.content }] };
      },
    );

    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    const names = toolsResult.tools.map((t) => t.name);
    expect(names).toContain("ReadFile");
    expect(names).toContain("WriteFile");
    expect(names).toContain("EditFile");
    expect(names).toContain("Bash");
    expect(names).toContain("Glob");
    expect(names).toContain("Grep");

    await client.close();
    await server.close();
  });

  it("calls a tool and returns result", async () => {
    const registry = new ToolRegistry();
    const toolCtx = makeToolContext();

    const [clientTransport, serverTransport] = createTransportPair();

    const server = new Server(
      { name: "noumen-test", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: registry.listTools().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: {
          type: "object" as const,
          properties: t.parameters.properties as Record<string, object>,
        },
      })),
    }));

    server.setRequestHandler(
      CallToolRequestSchema,
      async ({ params: { name, arguments: args } }) => {
        const tool = registry.get(name);
        if (!tool) {
          return { isError: true, content: [{ type: "text", text: `Unknown: ${name}` }] };
        }
        const result = await tool.call((args ?? {}) as Record<string, unknown>, toolCtx);
        return { content: [{ type: "text", text: result.content }] };
      },
    );

    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "ReadFile",
      arguments: { file_path: "/test.txt" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("hello world");

    await client.close();
    await server.close();
  });

  it("includes additional tools when provided", async () => {
    const customTool: Tool = {
      name: "MyTool",
      description: "Custom tool for testing",
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
      async call(args) {
        return { content: `Got: ${args.input}` };
      },
    };

    const registry = new ToolRegistry([customTool]);
    const toolCtx = makeToolContext();

    const [clientTransport, serverTransport] = createTransportPair();

    const server = new Server(
      { name: "noumen-test", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: registry.listTools().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: {
          type: "object" as const,
          properties: t.parameters.properties as Record<string, object>,
        },
      })),
    }));

    server.setRequestHandler(
      CallToolRequestSchema,
      async ({ params: { name, arguments: args } }) => {
        const tool = registry.get(name);
        if (!tool) {
          return { isError: true, content: [{ type: "text", text: `Unknown: ${name}` }] };
        }
        const result = await tool.call((args ?? {}) as Record<string, unknown>, toolCtx);
        return { content: [{ type: "text", text: result.content }] };
      },
    );

    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    expect(toolsResult.tools.map((t) => t.name)).toContain("MyTool");

    const result = await client.callTool({
      name: "MyTool",
      arguments: { input: "hello" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe("Got: hello");

    await client.close();
    await server.close();
  });
});
