import { describe, it, expect } from "vitest";
import { Agent } from "../agent.js";
import { LocalAgent } from "../local.js";
import { UnsandboxedAgent } from "../unsandboxed.js";
import { MockAIProvider, textResponse } from "./helpers.js";

function mockProvider() {
  return new MockAIProvider([textResponse("ok")]);
}

describe("LocalAgent / UnsandboxedAgent shortcuts", () => {
  it("UnsandboxedAgent constructs an Agent without requiring an explicit sandbox", () => {
    const agent = UnsandboxedAgent({
      provider: mockProvider(),
      cwd: "/tmp",
    });
    expect(agent).toBeInstanceOf(Agent);
  });

  it("LocalAgent constructs an Agent without requiring an explicit sandbox", () => {
    const agent = LocalAgent({
      provider: mockProvider(),
      cwd: "/tmp",
    });
    expect(agent).toBeInstanceOf(Agent);
  });

  it("UnsandboxedAgent forwards options (systemPrompt, model) through", () => {
    const agent = UnsandboxedAgent({
      provider: mockProvider(),
      cwd: "/tmp",
      options: {
        systemPrompt: "You are a coder.",
        model: "gpt-4o",
      },
    });
    expect(agent).toBeInstanceOf(Agent);
  });

  it("UnsandboxedAgent falls back to process.cwd() when no cwd is supplied", () => {
    const agent = UnsandboxedAgent({ provider: mockProvider() });
    expect(agent).toBeInstanceOf(Agent);
  });

  it("LocalAgent falls back to process.cwd() when no cwd is supplied", () => {
    const agent = LocalAgent({ provider: mockProvider() });
    expect(agent).toBeInstanceOf(Agent);
  });

  it("LocalAgent accepts tunable sandbox restrictions via localSandbox", () => {
    const agent = LocalAgent({
      provider: mockProvider(),
      cwd: "/tmp",
      localSandbox: {
        defaultTimeout: 60_000,
        sandbox: { filesystem: { allowWrite: ["/tmp/extra"] } },
      },
    });
    expect(agent).toBeInstanceOf(Agent);
  });

  it("UnsandboxedAgent accepts tunable command timeout via unsandboxed", () => {
    const agent = UnsandboxedAgent({
      provider: mockProvider(),
      cwd: "/tmp",
      unsandboxed: { defaultTimeout: 60_000 },
    });
    expect(agent).toBeInstanceOf(Agent);
  });
});
