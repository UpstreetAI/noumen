import { describe, it, expect, beforeEach } from "vitest";
import { MockFs, MockComputer, MockAIProvider, textChunk, stopChunk } from "./helpers.js";
import { Agent } from "../agent.js";
import { SessionStorage } from "../session/storage.js";
import type { ChatStreamChunk } from "../providers/types.js";

function titleResponse(json: string): ChatStreamChunk[] {
  return [textChunk(json), stopChunk()];
}

let fs: MockFs;
let computer: MockComputer;
let seed: SessionStorage;

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  seed = new SessionStorage(fs, "/sessions");
});

describe("Agent session title + persistence surface", () => {
  it("setCustomTitle writes a custom-title entry", async () => {
    const provider = new MockAIProvider();
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: { sessionDir: "/sessions" },
    });

    await agent.setCustomTitle("s1", "My thread");
    const t = await agent.getSessionTitles("s1");
    expect(t.customTitle).toBe("My thread");
    expect(t.title).toBe("My thread");
  });

  it("setCustomTitle is a no-op on empty input", async () => {
    const provider = new MockAIProvider();
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: { sessionDir: "/sessions" },
    });
    await agent.setCustomTitle("s1", "   ");
    const t = await agent.getSessionTitles("s1");
    expect(t.customTitle).toBeUndefined();
  });

  it("setAiTitle writes an ai-title entry", async () => {
    const provider = new MockAIProvider();
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: { sessionDir: "/sessions" },
    });

    await agent.setAiTitle("s1", "Fix login");
    const t = await agent.getSessionTitles("s1");
    expect(t.aiTitle).toBe("Fix login");
    expect(t.title).toBe("Fix login");
  });

  it("getMessages returns the session's loaded messages", async () => {
    const provider = new MockAIProvider();
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: { sessionDir: "/sessions" },
    });

    await seed.appendMessage("s1", { role: "user", content: "first" });
    await seed.appendMessage("s1", { role: "assistant", content: "reply" });

    const msgs = await agent.getMessages("s1");
    expect(msgs).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
    ]);
  });

  it("deleteSession removes the transcript", async () => {
    const provider = new MockAIProvider();
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: { sessionDir: "/sessions" },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });

    await agent.deleteSession("s1");
    const msgs = await agent.getMessages("s1");
    expect(msgs).toEqual([]);
  });
});

describe("Agent.autoTitleIfMissing", () => {
  it("returns null when autoTitle is disabled", async () => {
    const provider = new MockAIProvider([titleResponse('{"title": "X"}')]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: { sessionDir: "/sessions", model: "mock-model" },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });
    const result = await agent.autoTitleIfMissing("s1");
    expect(result).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it("generates and persists an ai-title when missing", async () => {
    const provider = new MockAIProvider([
      titleResponse('{"title": "Fix login button"}'),
    ]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: true,
      },
    });
    await seed.appendMessage("s1", {
      role: "user",
      content: "the login button does nothing on mobile",
    });

    const result = await agent.autoTitleIfMissing("s1");
    expect(result).toBe("Fix login button");

    const t = await agent.getSessionTitles("s1");
    expect(t.aiTitle).toBe("Fix login button");
    expect(t.customTitle).toBeUndefined();
    expect(t.title).toBe("Fix login button");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].model).toBe("mock-model");
  });

  it("skips when a custom-title already exists", async () => {
    const provider = new MockAIProvider([
      titleResponse('{"title": "Should not run"}'),
    ]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: true,
      },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });
    await agent.setCustomTitle("s1", "User picked");

    const result = await agent.autoTitleIfMissing("s1");
    expect(result).toBeNull();
    expect(provider.calls).toHaveLength(0);

    const t = await agent.getSessionTitles("s1");
    expect(t.title).toBe("User picked");
  });

  it("skips when an ai-title already exists", async () => {
    const provider = new MockAIProvider([
      titleResponse('{"title": "Should not run"}'),
    ]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: true,
      },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });
    await agent.setAiTitle("s1", "Already titled");

    const result = await agent.autoTitleIfMissing("s1");
    expect(result).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it("respects { force: true } and overwrites the ai-title", async () => {
    const provider = new MockAIProvider([
      titleResponse('{"title": "Refreshed title"}'),
    ]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: true,
      },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });
    await agent.setAiTitle("s1", "Stale title");

    const result = await agent.autoTitleIfMissing("s1", { force: true });
    expect(result).toBe("Refreshed title");

    const t = await agent.getSessionTitles("s1");
    expect(t.aiTitle).toBe("Refreshed title");
    expect(provider.calls).toHaveLength(1);
  });

  it("returns null when the session has no messages", async () => {
    const provider = new MockAIProvider([titleResponse('{"title": "X"}')]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: true,
      },
    });
    const result = await agent.autoTitleIfMissing("empty-session");
    expect(result).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it("coalesces concurrent calls for the same session", async () => {
    const provider = new MockAIProvider([
      titleResponse('{"title": "Only once"}'),
    ]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: true,
      },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });

    const [a, b, c] = await Promise.all([
      agent.autoTitleIfMissing("s1"),
      agent.autoTitleIfMissing("s1"),
      agent.autoTitleIfMissing("s1"),
    ]);
    expect(a).toBe("Only once");
    expect(b).toBe("Only once");
    expect(c).toBe("Only once");
    expect(provider.calls).toHaveLength(1);
  });

  it("does not coalesce a force call onto a concurrent non-force call", async () => {
    // A concurrent `force: true` call must not inherit the non-force
    // early-exit. If it did, a user pressing "regenerate title" while a
    // background autoTitle was already running on the same session would
    // silently get the non-force result (possibly null / stale) instead
    // of their forced regeneration.
    const provider = new MockAIProvider([
      titleResponse('{"title": "Forced run"}'),
    ]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: true,
      },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });
    // Pre-seed an ai-title so the non-force call exits early without
    // consuming a provider response.
    await agent.setAiTitle("s1", "Previously set");

    const [normal, forced] = await Promise.all([
      agent.autoTitleIfMissing("s1"),
      agent.autoTitleIfMissing("s1", { force: true }),
    ]);
    expect(normal).toBeNull();
    expect(forced).toBe("Forced run");

    const t = await agent.getSessionTitles("s1");
    expect(t.aiTitle).toBe("Forced run");
    expect(provider.calls).toHaveLength(1);
  });

  it("coalesces concurrent force calls with each other", async () => {
    const provider = new MockAIProvider([
      titleResponse('{"title": "Forced once"}'),
    ]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: true,
      },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });
    await agent.setAiTitle("s1", "Stale");

    const [a, b] = await Promise.all([
      agent.autoTitleIfMissing("s1", { force: true }),
      agent.autoTitleIfMissing("s1", { force: true }),
    ]);
    expect(a).toBe("Forced once");
    expect(b).toBe("Forced once");
    expect(provider.calls).toHaveLength(1);
  });

  it("releases the in-flight slot on error so retries can run", async () => {
    const provider = new MockAIProvider([titleResponse('{"title": "Retry"}')]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: true,
      },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });

    // First call: provider has no response queued beyond the first slot,
    // but after the first call consumes it a retry must be able to start
    // fresh instead of being blocked by a stale in-flight entry.
    const first = await agent.autoTitleIfMissing("s1");
    expect(first).toBe("Retry");

    // Second call with force: must not be blocked by a lingering promise.
    const provider2Calls = provider.calls.length;
    const second = await agent.autoTitleIfMissing("s1", { force: true });
    // No more queued responses — provider throws; generateAutoTitle swallows.
    expect(second).toBeNull();
    expect(provider.calls.length).toBeGreaterThan(provider2Calls);
  });

  it("autoTitle: false is equivalent to omitting the option", async () => {
    const provider = new MockAIProvider([titleResponse('{"title": "X"}')]);
    const agent = new Agent({
      provider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: false,
      },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });
    const result = await agent.autoTitleIfMissing("s1");
    expect(result).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it("autoTitle: { enabled: false } is respected even with other fields set", async () => {
    const titleProvider = new MockAIProvider([
      titleResponse('{"title": "Should not run"}'),
    ]);
    const agent = new Agent({
      provider: new MockAIProvider(),
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "mock-model",
        autoTitle: { enabled: false, provider: titleProvider },
      },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });
    const result = await agent.autoTitleIfMissing("s1");
    expect(result).toBeNull();
    expect(titleProvider.calls).toHaveLength(0);
  });

  it("uses an object autoTitle config with a custom provider", async () => {
    const mainProvider = new MockAIProvider();
    const titleProvider = new MockAIProvider([
      titleResponse('{"title": "From aux provider"}'),
    ]);
    const agent = new Agent({
      provider: mainProvider,
      sandbox: { fs, computer },
      options: {
        sessionDir: "/sessions",
        model: "main-model",
        autoTitle: {
          provider: titleProvider,
          model: "haiku-mock",
          systemPrompt: "custom prompt",
          maxInputChars: 500,
        },
      },
    });
    await seed.appendMessage("s1", { role: "user", content: "hi" });

    const result = await agent.autoTitleIfMissing("s1");
    expect(result).toBe("From aux provider");
    expect(titleProvider.calls).toHaveLength(1);
    expect(titleProvider.calls[0].model).toBe("haiku-mock");
    expect(titleProvider.calls[0].system).toBe("custom prompt");
    expect(mainProvider.calls).toHaveLength(0);
  });
});
