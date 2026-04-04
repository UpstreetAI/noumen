import { describe, it, expect } from "vitest";
import { MockAIProvider, textResponse, MockFs, MockComputer } from "./helpers.js";
import { Agent, type DiagnoseResult } from "../agent.js";

function mockProvider() {
  return new MockAIProvider([textResponse("ok")]);
}

describe("diagnose() sandbox-runtime check", () => {
  it("includes sandboxRuntime field in diagnose result", async () => {
    const agent = new Agent({
      provider: mockProvider(),
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });

    const result: DiagnoseResult = await agent.diagnose();

    expect(result.sandboxRuntime).toBeDefined();
    expect(typeof result.sandboxRuntime.ok).toBe("boolean");
    expect(result.sandboxRuntime.platform).toBe(process.platform);
  });

  it("reports warning when sandbox-runtime is not installed", async () => {
    const agent = new Agent({
      provider: mockProvider(),
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });

    const result = await agent.diagnose();

    // In the test environment, sandbox-runtime is likely not installed.
    // Whether ok is true or false depends on the test host, but the
    // field must be present and typed correctly.
    expect(result.sandboxRuntime).toBeDefined();
    if (!result.sandboxRuntime.ok) {
      expect(result.sandboxRuntime.warning).toBeTruthy();
    }
  });

  it("does not affect overall health when sandbox-runtime is unavailable", async () => {
    const agent = new Agent({
      provider: mockProvider(),
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });

    const result = await agent.diagnose();

    // overall should still be true as long as provider + sandbox pass,
    // regardless of sandbox-runtime availability
    expect(result.overall).toBe(true);
    expect(result.provider.ok).toBe(true);
    expect(result.sandbox.fs.ok).toBe(true);
    expect(result.sandbox.computer.ok).toBe(true);
  });
});
