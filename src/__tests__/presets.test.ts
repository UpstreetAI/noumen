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
  it("returns a structured result with all expected fields", async () => {
    const provider = new MockAIProvider([textResponse("ok")]);
    const code = new Code({
      aiProvider: provider,
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });

    const result: DiagnoseResult = await code.diagnose();

    expect(result.overall).toBe(true);
    expect(result.timestamp).toBeTruthy();
    expect(result.provider.ok).toBe(true);
    expect(result.sandbox.fs.ok).toBe(true);
    expect(result.sandbox.computer.ok).toBe(true);
    expect(result.mcp).toEqual({});
    expect(result.lsp).toEqual({});
  });

  it("records latency on successful checks", async () => {
    const provider = new MockAIProvider([textResponse("ok")]);
    const code = new Code({
      aiProvider: provider,
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });

    const result = await code.diagnose();

    expect(result.provider.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.sandbox.fs.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.sandbox.computer.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports provider errors gracefully and sets overall to false", async () => {
    const failingProvider: any = {
      async *chat() { throw new Error("API key invalid"); },
    };
    const code = new Code({
      aiProvider: failingProvider,
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });
    const result = await code.diagnose();
    expect(result.overall).toBe(false);
    expect(result.provider.ok).toBe(false);
    expect(result.provider.error).toContain("API key invalid");
    expect(result.sandbox.fs.ok).toBe(true);
    expect(result.sandbox.computer.ok).toBe(true);
  });

  it("reports sandbox filesystem errors", async () => {
    const brokenFs: any = {
      async exists() { throw new Error("fs unavailable"); },
    };
    const code = new Code({
      aiProvider: mockProvider(),
      sandbox: { fs: brokenFs, computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });
    const result = await code.diagnose();
    expect(result.overall).toBe(false);
    expect(result.sandbox.fs.ok).toBe(false);
    expect(result.sandbox.fs.error).toContain("fs unavailable");
  });

  it("reports sandbox computer errors", async () => {
    const brokenComputer = new MockComputer(() => {
      throw new Error("shell unavailable");
    });
    const code = new Code({
      aiProvider: mockProvider(),
      sandbox: { fs: new MockFs(), computer: brokenComputer },
      options: { cwd: "/tmp" },
    });
    const result = await code.diagnose();
    expect(result.overall).toBe(false);
    expect(result.sandbox.computer.ok).toBe(false);
    expect(result.sandbox.computer.error).toContain("shell unavailable");
  });

  it("reports non-zero exit code as a warning", async () => {
    const failComputer = new MockComputer(() => ({
      exitCode: 1, stdout: "", stderr: "error",
    }));
    const code = new Code({
      aiProvider: mockProvider(),
      sandbox: { fs: new MockFs(), computer: failComputer },
      options: { cwd: "/tmp" },
    });
    const result = await code.diagnose();
    expect(result.overall).toBe(false);
    expect(result.sandbox.computer.ok).toBe(false);
    expect(result.sandbox.computer.warning).toContain("non-zero");
  });

  it("times out slow provider checks", async () => {
    const slowProvider: any = {
      async *chat() {
        await new Promise((r) => setTimeout(r, 5000));
        yield { id: "x", model: "m", choices: [] };
      },
    };
    const code = new Code({
      aiProvider: slowProvider,
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });
    const result = await code.diagnose(100);
    expect(result.provider.ok).toBe(false);
    expect(result.provider.error).toContain("Timed out");
  });

  it("includes model in provider result", async () => {
    const code = new Code({
      aiProvider: mockProvider(),
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp", model: "gpt-4o" },
    });
    const result = await code.diagnose();
    expect(result.provider.model).toBe("gpt-4o");
  });

  it("includes timestamp as ISO string", async () => {
    const code = new Code({
      aiProvider: mockProvider(),
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });
    const before = new Date().toISOString();
    const result = await code.diagnose();
    const after = new Date().toISOString();
    expect(result.timestamp >= before).toBe(true);
    expect(result.timestamp <= after).toBe(true);
  });
});
