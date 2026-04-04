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

  it("reports platform support status", async () => {
    const agent = new Agent({
      provider: mockProvider(),
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });

    const result = await agent.diagnose();

    expect(result.sandboxRuntime).toBeDefined();
    // On macOS/Linux in CI the runtime should be functional;
    // on unsupported platforms it reports a warning.
    if (!result.sandboxRuntime.ok) {
      expect(result.sandboxRuntime.warning).toBeTruthy();
    }
  });

  it("does not affect overall health based on sandbox-runtime status", async () => {
    const agent = new Agent({
      provider: mockProvider(),
      sandbox: { fs: new MockFs(), computer: new MockComputer() },
      options: { cwd: "/tmp" },
    });

    const result = await agent.diagnose();

    // overall depends on provider + sandbox fs/computer, not sandbox-runtime
    expect(result.overall).toBe(true);
    expect(result.provider.ok).toBe(true);
    expect(result.sandbox.fs.ok).toBe(true);
    expect(result.sandbox.computer.ok).toBe(true);
  });
});
