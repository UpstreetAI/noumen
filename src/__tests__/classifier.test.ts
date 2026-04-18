import { describe, it, expect } from "vitest";
import { classifyPermission } from "../permissions/classifier.js";
import type { AIProvider, ChatStreamChunk } from "../providers/types.js";
import type { ChatMessage } from "../session/types.js";

function makeChunk(text: string): ChatStreamChunk {
  return {
    id: "c1",
    model: "test",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function mockProvider(chunks: ChatStreamChunk[]): AIProvider {
  return {
    async *chat() {
      for (const c of chunks) yield c;
    },
  };
}

const msgs: ChatMessage[] = [{ role: "user", content: "hello" }];

describe("classifyPermission", () => {
  it("returns shouldBlock when no model is configured", async () => {
    const provider = mockProvider([]);
    const result = await classifyPermission("ReadFile", {}, msgs, provider);
    expect(result.shouldBlock).toBe(true);
    expect(result.reason).toContain("No model configured");
  });

  it("returns shouldBlock when only classifierModel is undefined and model is undefined", async () => {
    const provider = mockProvider([]);
    const result = await classifyPermission("ReadFile", {}, msgs, provider, {});
    expect(result.shouldBlock).toBe(true);
    expect(result.reason).toContain("No model configured");
  });

  it("parses valid JSON response (happy path)", async () => {
    const provider = mockProvider([
      makeChunk('{"shouldBlock":'),
      makeChunk(' false, "reason":'),
      makeChunk(' "safe read operation"}'),
    ]);
    const result = await classifyPermission("ReadFile", { path: "/src/foo.ts" }, msgs, provider, {
      model: "test-model",
    });
    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe("safe read operation");
  });

  it("uses classifierModel over model when both provided", async () => {
    const provider = mockProvider([
      makeChunk('{"shouldBlock": true, "reason": "dangerous"}'),
    ]);
    const result = await classifyPermission("Bash", { command: "rm -rf /" }, msgs, provider, {
      classifierModel: "classifier-v1",
      model: "fallback-model",
    });
    expect(result.shouldBlock).toBe(true);
    expect(result.reason).toBe("dangerous");
  });

  it("defaults missing fields in parsed JSON", async () => {
    const provider = mockProvider([makeChunk("{}")]);
    const result = await classifyPermission("ReadFile", {}, msgs, provider, {
      model: "test-model",
    });
    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe("unknown");
  });

  it("fails closed on malformed JSON", async () => {
    const provider = mockProvider([makeChunk("not valid json at all")]);
    const result = await classifyPermission("Bash", { command: "echo hi" }, msgs, provider, {
      model: "test-model",
    });
    expect(result.shouldBlock).toBe(true);
    expect(result.reason).toContain("Classifier failed");
  });

  it("fails closed when abort signal fires mid-stream", async () => {
    const controller = new AbortController();
    const provider: AIProvider = {
      defaultModel: "mock-model",
      async *chat() {
        yield makeChunk('{"shouldBlock": false');
        controller.abort();
        yield makeChunk(', "reason": "ok"}');
      },
    };
    const result = await classifyPermission("ReadFile", {}, msgs, provider, {
      model: "test-model",
      signal: controller.signal,
    });
    // AbortError is caught by the outer catch → fail closed
    expect(result.shouldBlock).toBe(true);
    expect(result.reason).toContain("Classifier failed");
  });

  it("fails closed when provider.chat throws", async () => {
    const provider: AIProvider = {
      defaultModel: "mock-model",
      async *chat() {
        throw new Error("network failure");
      },
    };
    const result = await classifyPermission("ReadFile", {}, msgs, provider, {
      model: "test-model",
    });
    expect(result.shouldBlock).toBe(true);
    expect(result.reason).toContain("Classifier failed");
  });

  it("accepts custom classifier prompt", async () => {
    let capturedSystem: string | undefined;
    const provider: AIProvider = {
      defaultModel: "mock-model",
      async *chat(params) {
        capturedSystem = params.system;
        yield makeChunk('{"shouldBlock": false, "reason": "allowed"}');
      },
    };
    await classifyPermission("ReadFile", {}, msgs, provider, {
      model: "test-model",
      classifierPrompt: "Custom prompt",
    });
    expect(capturedSystem).toBe("Custom prompt");
  });

  it("truncates context to last 6 messages", async () => {
    let capturedMessages: unknown;
    const longMsgs: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i}`,
    }));
    const provider: AIProvider = {
      defaultModel: "mock-model",
      async *chat(params) {
        capturedMessages = params.messages;
        yield makeChunk('{"shouldBlock": false, "reason": "ok"}');
      },
    };
    await classifyPermission("ReadFile", {}, longMsgs, provider, { model: "m" });
    const userContent = (capturedMessages as Array<{ content: string }>)[0].content;
    expect(userContent).toContain("message 4");
    expect(userContent).not.toContain("message 3");
  });
});
