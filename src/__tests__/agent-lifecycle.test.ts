import { describe, it, expect, beforeEach } from "vitest";
import { MockFs, MockComputer, MockAIProvider, textResponse, toolCallResponse } from "./helpers.js";
import { Agent } from "../agent.js";
import { Thread } from "../thread.js";
import type { StreamEvent } from "../session/types.js";

let fs: MockFs;
let computer: MockComputer;
let provider: MockAIProvider;

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  provider = new MockAIProvider();
});

describe("Agent", () => {
  it("createThread returns a Thread instance", async () => {
    const code = new Agent({
      provider: provider,
      sandbox: { fs, computer },
    });

    const thread = await code.createThread();
    expect(thread).toBeInstanceOf(Thread);
    expect(thread.sessionId).toBeTruthy();
  });

  it("createThread uses provided sessionId", async () => {
    const code = new Agent({
      provider: provider,
      sandbox: { fs, computer },
    });

    const thread = await code.createThread({ sessionId: "my-session" });
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

    const thread = await code.createThread({ sessionId: "s1" });
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

    const thread = await code.createThread({ sessionId: "s1" });
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
    const thread = await code.createThread({ sessionId: "s1" });
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
    const thread = await code.createThread({ sessionId: "s1" });
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
    const thread = await code.createThread({ sessionId: "s1" });
    for await (const _ of thread.run("hi")) {
      // consume
    }

    expect(provider.calls[0].model).toBe("gpt-4o-mini");
    expect(provider.calls[0].max_tokens).toBe(2048);
  });

  describe("run()", () => {
    it("returns an AsyncGenerator that yields stream events", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
      });

      provider.addResponse(textResponse("hello world"));

      const events: StreamEvent[] = [];
      for await (const event of agent.run("say hello")) {
        events.push(event);
      }

      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents.length).toBeGreaterThanOrEqual(1);
      expect(textEvents[0].type === "text_delta" && textEvents[0].text).toBe("hello world");

      expect(events.some((e) => e.type === "turn_complete")).toBe(true);
    });

    it("passes RunOptions through to the thread", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
      });

      provider.addResponse(textResponse("ok"));

      const events: StreamEvent[] = [];
      for await (const event of agent.run("hi", { maxTurns: 1 })) {
        events.push(event);
      }

      expect(events.some((e) => e.type === "turn_complete")).toBe(true);
    });
  });

  describe("execute()", () => {
    it("returns a RunResult with text and usage", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
      });

      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      provider.addResponse(textResponse("the answer", usage));

      const result = await agent.execute("what is it");

      expect(result.text).toBe("the answer");
      expect(result.toolCalls).toBe(0);
      expect(result.usage.total_tokens).toBe(15);
      expect(result.sessionId).toBeTruthy();
    });

    it("counts tool calls in the result", async () => {
      fs.files.set("/test.txt", "content");
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
      });

      provider.addResponse(
        toolCallResponse("tc1", "ReadFile", { path: "/test.txt" }),
      );
      provider.addResponse(textResponse("done"));

      const result = await agent.execute("read the file");

      expect(result.toolCalls).toBeGreaterThanOrEqual(1);
      expect(result.text).toBe("done");
    });

    it("fires onText callback for each text delta", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
      });

      provider.addResponse(textResponse("hello"));

      const chunks: string[] = [];
      await agent.execute("say hello", {
        onText: (text) => chunks.push(text),
      });

      expect(chunks.join("")).toBe("hello");
    });

    it("fires onToolUse callback for tool calls", async () => {
      fs.files.set("/x.txt", "data");
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
      });

      provider.addResponse(
        toolCallResponse("tc1", "ReadFile", { path: "/x.txt" }),
      );
      provider.addResponse(textResponse("ok"));

      const toolNames: string[] = [];
      await agent.execute("read x.txt", {
        onToolUse: (name) => toolNames.push(name),
      });

      expect(toolNames).toContain("ReadFile");
    });

    it("fires onComplete callback with the final result", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
      });

      provider.addResponse(textResponse("done"));

      let capturedResult: unknown = null;
      const result = await agent.execute("do it", {
        onComplete: (r) => { capturedResult = r; },
      });

      expect(capturedResult).toBe(result);
      expect(result.text).toBe("done");
    });

    it("works without any callbacks", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
      });

      provider.addResponse(textResponse("plain result"));

      const result = await agent.execute("go");

      expect(result.text).toBe("plain result");
      expect(result.sessionId).toBeTruthy();
    });
  });

  describe("Agent lifecycle", () => {
    it("resumeThread returns a Thread for an existing session", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
      });

      provider.addResponse(textResponse("reply"));
      const thread1 = await agent.createThread({ sessionId: "s1" });
      for await (const _ of thread1.run("hi")) { /* consume */ }

      const thread2 = await agent.resumeThread("s1");
      expect(thread2).toBeInstanceOf(Thread);
      expect(thread2.sessionId).toBe("s1");
    });

    it("close() calls sandbox.dispose if available", async () => {
      let disposed = false;
      const disposableSandbox = {
        fs, computer,
        dispose: async () => { disposed = true; },
      };

      const agent = new Agent({
        provider: provider,
        sandbox: disposableSandbox,
      });

      await agent.close();
      expect(disposed).toBe(true);
    });
  });

  describe("dotDirs routing", () => {
    it("writes sessions under the default .noumen directory", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
        cwd: "/proj",
      });

      provider.addResponse(textResponse("reply"));
      const thread = await agent.createThread({ sessionId: "sess-default" });
      for await (const _ of thread.run("hi")) { /* consume */ }

      const sessionKeys = [...fs.files.keys()].filter((k) => k.includes("sess-default"));
      expect(sessionKeys.length).toBeGreaterThan(0);
      expect(sessionKeys.every((k) => k.includes("/.noumen/sessions/"))).toBe(true);
    });

    it("reroutes sessions when dotDirs.names is overridden", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
        cwd: "/proj",
        options: { dotDirs: { names: [".mine", ".noumen"] } },
      });

      provider.addResponse(textResponse("reply"));
      const thread = await agent.createThread({ sessionId: "sess-mine" });
      for await (const _ of thread.run("hi")) { /* consume */ }

      const sessionKeys = [...fs.files.keys()].filter((k) => k.includes("sess-mine"));
      expect(sessionKeys.length).toBeGreaterThan(0);
      expect(sessionKeys.every((k) => k.includes("/.mine/sessions/"))).toBe(true);
    });

    it("routes checkpoint backupDir through the resolver default", async () => {
      fs.files.set("/proj/a.ts", "original");

      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
        cwd: "/proj",
        options: {
          checkpoint: { enabled: true, maxSnapshots: 5 },
        },
      });

      provider.addResponse(textResponse("reply"));
      const thread = await agent.createThread({ sessionId: "sess-ckpt" });
      for await (const _ of thread.run("hi")) { /* consume */ }

      const cm = (agent as any).checkpointManager;
      expect(cm).toBeDefined();
      expect((cm as any).backupDir).toBe("/proj/.noumen/checkpoints");
    });

    it("reroutes checkpoint backupDir when dotDirs.names overrides default", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
        cwd: "/proj",
        options: {
          dotDirs: { names: [".mine"] },
          checkpoint: { enabled: true, maxSnapshots: 5 },
        },
      });

      const cm = (agent as any).checkpointManager;
      expect(cm).toBeDefined();
      expect((cm as any).backupDir).toBe("/proj/.mine/checkpoints");
    });

    it("explicit sessionDir beats the resolver default", async () => {
      const agent = new Agent({
        provider: provider,
        sandbox: { fs, computer },
        cwd: "/proj",
        options: {
          dotDirs: { names: [".mine"] },
          sessionDir: "/custom-sessions",
        },
      });

      provider.addResponse(textResponse("reply"));
      const thread = await agent.createThread({ sessionId: "sess-custom" });
      for await (const _ of thread.run("hi")) { /* consume */ }

      const sessionKeys = [...fs.files.keys()].filter((k) => k.includes("sess-custom"));
      expect(sessionKeys.length).toBeGreaterThan(0);
      expect(sessionKeys.every((k) => k.startsWith("/custom-sessions/"))).toBe(true);
    });
  });
});
