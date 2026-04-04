import { describe, it, expect } from "vitest";
import { MockAIProvider, textResponse, MockFs, MockComputer } from "./helpers.js";
import { codingAgent, planningAgent, reviewAgent } from "../presets.js";
import { Code, type DiagnoseResult } from "../code.js";

function mockProvider() {
  return new MockAIProvider([textResponse("ok")]);
}

describe("codingAgent preset", () => {
  it("returns a Code instance", () => {
    const code = codingAgent({ provider: mockProvider(), cwd: "/tmp" });
    expect(code).toBeInstanceOf(Code);
  });

  it("accepts optional hooks and systemPrompt", () => {
    const code = codingAgent({
      provider: mockProvider(),
      cwd: "/tmp",
      hooks: [{ event: "TurnStart", handler: async () => {} }],
      systemPrompt: "You are a coder.",
    });
    expect(code).toBeInstanceOf(Code);
  });
});

describe("planningAgent preset", () => {
  it("returns a Code instance", () => {
    const code = planningAgent({ provider: mockProvider(), cwd: "/tmp" });
    expect(code).toBeInstanceOf(Code);
  });
});

describe("reviewAgent preset", () => {
  it("returns a Code instance", () => {
    const code = reviewAgent({ provider: mockProvider(), cwd: "/tmp" });
    expect(code).toBeInstanceOf(Code);
  });
});

describe("Code.diagnose()", () => {
  it("returns a structured result with provider and sandbox status", async () => {
    const provider = new MockAIProvider([textResponse("ok")]);
    const code = new Code({
      aiProvider: provider,
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });

    const result: DiagnoseResult = await code.diagnose();

    expect(result).toHaveProperty("provider");
    expect(result).toHaveProperty("sandbox");
    expect(result).toHaveProperty("mcp");
    expect(result).toHaveProperty("lsp");

    expect(result.sandbox.fs).toBe(true);
    expect(result.sandbox.computer).toBe(true);
    expect(result.mcp).toEqual({});
    expect(result.lsp).toEqual({});
  });

  it("reports provider errors gracefully", async () => {
    const failingProvider: any = {
      async *chat() { throw new Error("API key invalid"); },
    };
    const code = new Code({
      aiProvider: failingProvider,
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });
    const result = await code.diagnose();
    expect(result.provider.ok).toBe(false);
    expect(result.provider.error).toContain("API key invalid");
  });
});
