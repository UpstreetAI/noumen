import { describe, it, expect, vi } from "vitest";

// Every optional peer dep declared in package.json `peerDependenciesMeta`,
// plus a handful of deep-import paths used inside those SDKs. If the root
// barrel ever statically touches any of these, loading it will throw the
// sentinel error below and this test fails.
//
// Add to this list any new optional peer you introduce.
const OPTIONAL_PEERS = [
  // Providers
  "openai",
  "@anthropic-ai/sdk",
  "@google/genai",
  "@anthropic-ai/bedrock-sdk",
  "@anthropic-ai/vertex-sdk",
  "google-auth-library",
  // MCP — the bare package has no main entry (subpath exports only), so
  // we mock the subpaths that the MCP client and server actually import.
  "@modelcontextprotocol/sdk/client/index.js",
  "@modelcontextprotocol/sdk/client/stdio.js",
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
  "@modelcontextprotocol/sdk/client/sse.js",
  "@modelcontextprotocol/sdk/client/websocket.js",
  "@modelcontextprotocol/sdk/client/auth.js",
  "@modelcontextprotocol/sdk/server/index.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "@modelcontextprotocol/sdk/shared/auth.js",
  "@modelcontextprotocol/sdk/types.js",
  // Sandbox backends
  "dockerode",
  "e2b",
  "freestyle-sandboxes",
  "ssh2",
  // Transport / observability / media
  "ws",
  "sharp",
  "@opentelemetry/api",
  "vscode-jsonrpc",
  "vscode-jsonrpc/node.js",
  // Web fetch HTML parser is a regular dep but loaded lazily — include it
  // so a regression that static-imports it at the barrel level is caught.
  "node-html-markdown",
];

for (const name of OPTIONAL_PEERS) {
  vi.doMock(name, () => {
    throw new Error(
      `optional peer '${name}' was loaded by the root barrel — see src/__tests__/barrel-cold-start.test.ts`,
    );
  });
}

describe("root barrel is structurally lightweight", () => {
  it("loads with every optional peer dep throwing on import", async () => {
    const mod = await import("../index.js");

    // Core surface should be present.
    expect(mod.Agent).toBeTypeOf("function");
    expect(mod.Thread).toBeTypeOf("function");
    expect(mod.LocalSandbox).toBeTypeOf("function");
    expect(mod.UnsandboxedLocal).toBeTypeOf("function");
    expect(mod.codingAgent).toBeTypeOf("function");
    expect(mod.planningAgent).toBeTypeOf("function");
    expect(mod.reviewAgent).toBeTypeOf("function");
    expect(mod.readFileTool).toBeDefined();
    expect(mod.bashTool).toBeDefined();
    expect(mod.ToolRegistry).toBeTypeOf("function");
    expect(mod.FileCheckpointManager).toBeTypeOf("function");
    expect(mod.CostTracker).toBeTypeOf("function");
    expect(mod.NoopTracer).toBeTypeOf("function");
    expect(mod.OTelTracer).toBeTypeOf("function");
  });

  it("does not re-export remote sandbox factories from the barrel", async () => {
    const mod = (await import("../index.js")) as unknown as Record<string, unknown>;

    // Remote sandbox bindings live on subpaths only.
    expect(mod.DockerSandbox).toBeUndefined();
    expect(mod.E2BSandbox).toBeUndefined();
    expect(mod.FreestyleSandbox).toBeUndefined();
    expect(mod.SshSandbox).toBeUndefined();
    expect(mod.SpritesSandbox).toBeUndefined();

    // Adapter primitives also move to subpaths.
    expect(mod.DockerFs).toBeUndefined();
    expect(mod.DockerComputer).toBeUndefined();
    expect(mod.E2BFs).toBeUndefined();
    expect(mod.E2BComputer).toBeUndefined();
    expect(mod.FreestyleFs).toBeUndefined();
    expect(mod.FreestyleComputer).toBeUndefined();
    expect(mod.SshFs).toBeUndefined();
    expect(mod.SshComputer).toBeUndefined();
    expect(mod.SpritesFs).toBeUndefined();
    expect(mod.SpritesComputer).toBeUndefined();
  });

  it("provider subpaths remain pure types at the barrel level", async () => {
    const mod = (await import("../index.js")) as unknown as Record<string, unknown>;

    // Concrete provider classes must NOT come from the barrel — they live
    // on subpaths so their SDKs don't load unless opted into.
    expect(mod.OpenAIProvider).toBeUndefined();
    expect(mod.AnthropicProvider).toBeUndefined();
    expect(mod.GeminiProvider).toBeUndefined();
    expect(mod.OpenRouterProvider).toBeUndefined();
    expect(mod.BedrockAnthropicProvider).toBeUndefined();
    expect(mod.VertexAnthropicProvider).toBeUndefined();
    expect(mod.OllamaProvider).toBeUndefined();

    // But the resolver (which does a dynamic import internally) is fine.
    expect(mod.resolveProvider).toBeTypeOf("function");
    expect(mod.detectProvider).toBeTypeOf("function");
  });
});
