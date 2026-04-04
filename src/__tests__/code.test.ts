import { describe, it, expect, beforeEach } from "vitest";
import { MockFs, MockComputer, MockAIProvider, textResponse } from "./helpers.js";
import { Agent } from "../agent.js";
import { Thread } from "../thread.js";

let fs: MockFs;
let computer: MockComputer;
let provider: MockAIProvider;

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  provider = new MockAIProvider();
});

describe("Agent", () => {
  it("createThread returns a Thread instance", () => {
    const code = new Agent({
      provider: provider,
      sandbox: { fs, computer },
    });

    const thread = code.createThread();
    expect(thread).toBeInstanceOf(Thread);
    expect(thread.sessionId).toBeTruthy();
  });

  it("defaults sandbox to LocalSandbox when only cwd is provided", () => {
    const code = new Agent({
      provider: provider,
      cwd: "/tmp/test",
    });

    const thread = code.createThread();
    expect(thread).toBeInstanceOf(Thread);
  });

  it("createThread uses provided sessionId", () => {
    const code = new Agent({
      provider: provider,
      sandbox: { fs, computer },
    });

    const thread = code.createThread({ sessionId: "my-session" });
    expect(thread.sessionId).toBe("my-session");
  });

  it("listSessions returns empty when no sessions exist", async () => {
    const code = new Agent({
      provider: provider,
      sandbox: { fs, computer },
    });

    const sessions = await code.listSessions();
    expect(sessions).toEqual([]);
  });

  it("listSessions returns sessions after threads have run", async () => {
    const code = new Agent({
      provider: provider,
      sandbox: { fs, computer },
    });

    provider.addResponse(textResponse("reply"));

    const thread = code.createThread({ sessionId: "s1" });
    for await (const _ of thread.run("hi")) {
      // consume
    }

    const sessions = await code.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("s1");
    expect(sessions[0].messageCount).toBeGreaterThanOrEqual(2);
  });

  it("passes skills to thread", async () => {
    const code = new Agent({
      provider: provider,
      sandbox: { fs, computer },
      options: {
        skills: [{ name: "TestSkill", content: "Always test." }],
      },
    });

    provider.addResponse(textResponse("ok"));

    const thread = code.createThread({ sessionId: "s1" });
    for await (const _ of thread.run("do something")) {
      // consume
    }

    // With skills present, the Skill tool is added and skills are listed compactly
    const systemPrompt = provider.calls[0].system;
    expect(systemPrompt).toContain("TestSkill");
    expect(systemPrompt).toContain("Skill tool");
  });

  it("init() resolves skills from paths", async () => {
    fs.files.set("/skills/coding.md", "# Coding Standards\nUse TypeScript.");
    fs.dirs.add("/skills");

    const code = new Agent({
      provider: provider,
      sandbox: { fs, computer },
      options: {
        skillsPaths: ["/skills"],
      },
    });

    await code.init();

    provider.addResponse(textResponse("ok"));
    const thread = code.createThread({ sessionId: "s1" });
    for await (const _ of thread.run("hi")) {
      // consume
    }

    const systemPrompt = provider.calls[0].system;
    expect(systemPrompt).toContain("Coding Standards");
  });

  it("uses custom system prompt", async () => {
    const code = new Agent({
      provider: provider,
      sandbox: { fs, computer },
      options: {
        systemPrompt: "You are a pirate.",
      },
    });

    provider.addResponse(textResponse("Arrr"));
    const thread = code.createThread({ sessionId: "s1" });
    for await (const _ of thread.run("hi")) {
      // consume
    }

    expect(provider.calls[0].system).toContain("You are a pirate.");
    expect(provider.calls[0].system).not.toContain("AI coding assistant");
  });

  it("passes model and maxTokens to thread", async () => {
    const code = new Agent({
      provider: provider,
      sandbox: { fs, computer },
      options: {
        model: "gpt-4o-mini",
        maxTokens: 2048,
      },
    });

    provider.addResponse(textResponse("ok"));
    const thread = code.createThread({ sessionId: "s1" });
    for await (const _ of thread.run("hi")) {
      // consume
    }

    expect(provider.calls[0].model).toBe("gpt-4o-mini");
    expect(provider.calls[0].max_tokens).toBe(2048);
  });
});
