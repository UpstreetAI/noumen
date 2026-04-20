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

  it("does not re-export any sandbox factory or adapter from the barrel", async () => {
    const mod = (await import("../index.js")) as unknown as Record<string, unknown>;

    // Local sandbox factories live on their own subpaths now.
    expect(mod.LocalSandbox).toBeUndefined();
    expect(mod.UnsandboxedLocal).toBeUndefined();

    // Local adapter primitives move with the LocalSandbox factory.
    expect(mod.LocalFs).toBeUndefined();
    expect(mod.LocalComputer).toBeUndefined();
    expect(mod.SandboxedLocalComputer).toBeUndefined();

    // Remote sandbox bindings live on subpaths only.
    expect(mod.DockerSandbox).toBeUndefined();
    expect(mod.E2BSandbox).toBeUndefined();
    expect(mod.FreestyleSandbox).toBeUndefined();
    expect(mod.SshSandbox).toBeUndefined();
    expect(mod.SpritesSandbox).toBeUndefined();

    // Remote adapter primitives also live on subpaths only.
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

  it("exposes local sandbox factories on their dedicated subpaths", async () => {
    const localMod = (await import("../local.js")) as unknown as Record<string, unknown>;
    expect(localMod.LocalSandbox).toBeTypeOf("function");
    expect(localMod.LocalFs).toBeTypeOf("function");
    expect(localMod.LocalComputer).toBeTypeOf("function");
    expect(localMod.SandboxedLocalComputer).toBeTypeOf("function");

    const unsandboxedMod = (await import("../unsandboxed.js")) as unknown as Record<string, unknown>;
    expect(unsandboxedMod.UnsandboxedLocal).toBeTypeOf("function");
    // The unsandboxed subpath must not drag the sandboxed computer along.
    expect(unsandboxedMod.SandboxedLocalComputer).toBeUndefined();
    expect(unsandboxedMod.LocalSandbox).toBeUndefined();
  });

  it("AI SDK provider adapter is exposed from the barrel without pulling SDKs", async () => {
    const mod = (await import("../index.js")) as unknown as Record<string, unknown>;

    // The legacy vendor-specific provider classes are gone.
    expect(mod.OpenAIProvider).toBeUndefined();
    expect(mod.AnthropicProvider).toBeUndefined();
    expect(mod.GeminiProvider).toBeUndefined();
    expect(mod.OpenRouterProvider).toBeUndefined();
    expect(mod.BedrockAnthropicProvider).toBeUndefined();
    expect(mod.VertexAnthropicProvider).toBeUndefined();
    expect(mod.OllamaProvider).toBeUndefined();

    // The AI SDK adapter is a thin wrapper — it takes a LanguageModel
    // instance and has no static vendor imports.
    expect(mod.AiSdkProvider).toBeTypeOf("function");

    // The resolver (which does a dynamic import internally) is fine.
    expect(mod.resolveProvider).toBeTypeOf("function");
    expect(mod.detectProvider).toBeTypeOf("function");
  });

  it("does not statically pull host-fs modules", async () => {
    // Prior regressions this guards against:
    //
    // 1. `agent.ts` and `presets.ts` each statically imported
    //    `UnsandboxedLocal` for a default-sandbox fallback, transitively
    //    pulling `LocalComputer` → `node:child_process` into every
    //    consumer of the root barrel.
    // 2. `agent.ts` statically imported `node:fs/promises` + `node:path`
    //    at the top level for its sandbox-id index file, so
    //    `path.resolve(this.cwd, ...)` showed up in the `agent.ts` chunk
    //    and triggered "whole project was traced unintentionally"
    //    warnings in Next.js NFT / serverless-webpack.
    //
    // Both regressions would cause bundler dependency tracers to walk
    // from any root-barrel consumer (`codingAgent`, `SessionStorage`,
    // `Agent`, …) out into host-fs territory. Mock those built-ins so
    // that merely *importing* the barrel throws if anything statically
    // reaches them.
    vi.doMock("node:child_process", () => {
      throw new Error(
        "node:child_process was loaded by the root barrel — some module is statically importing UnsandboxedLocal / LocalComputer again",
      );
    });
    vi.doMock("node:fs/promises", () => {
      throw new Error(
        "node:fs/promises was loaded by the root barrel — host-fs access must stay behind a dynamic import (see session/sandbox-index.ts)",
      );
    });

    const mod = await import("../index.js");
    expect(mod.codingAgent).toBeTypeOf("function");
    expect(mod.planningAgent).toBeTypeOf("function");
    expect(mod.reviewAgent).toBeTypeOf("function");
    expect(mod.Agent).toBeTypeOf("function");
  });
});
