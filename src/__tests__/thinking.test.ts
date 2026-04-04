import { describe, it, expect, beforeEach } from "vitest";
import type { StreamEvent } from "../session/types.js";
import type { ChatStreamChunk } from "../providers/types.js";
import { Thread, type ThreadConfig } from "../thread.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textChunk,
  stopChunk,
} from "./helpers.js";

function thinkingChunk(text: string): ChatStreamChunk {
  return {
    id: "thinking-0",
    model: "mock-model",
    choices: [
      {
        index: 0,
        delta: { thinking_content: text },
        finish_reason: null,
      },
    ],
  };
}

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("Thinking support", () => {
  let fs: MockFs;
  let computer: MockComputer;
  let provider: MockAIProvider;
  let baseConfig: ThreadConfig;

  beforeEach(() => {
    fs = new MockFs();
    computer = new MockComputer();
    provider = new MockAIProvider();
    baseConfig = {
      provider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };
  });

  it("passes thinking config to the provider in ChatParams", async () => {
    provider.addResponse([textChunk("hello"), stopChunk()]);

    const thread = new Thread(
      {
        ...baseConfig,
        thinking: { type: "enabled", budgetTokens: 10000 },
      },
      { sessionId: "t1" },
    );

    await collectEvents(thread.run("hi"));

    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].thinking).toEqual({
      type: "enabled",
      budgetTokens: 10000,
    });
  });

  it("does not pass thinking config when not configured", async () => {
    provider.addResponse([textChunk("hello"), stopChunk()]);

    const thread = new Thread(baseConfig, { sessionId: "t2" });
    await collectEvents(thread.run("hi"));

    expect(provider.calls[0].thinking).toBeUndefined();
  });

  it("yields thinking_delta events from the stream", async () => {
    provider.addResponse([
      thinkingChunk("Let me think..."),
      thinkingChunk(" about this."),
      textChunk("Here is the answer."),
      stopChunk(),
    ]);

    const thread = new Thread(
      {
        ...baseConfig,
        thinking: { type: "enabled", budgetTokens: 5000 },
      },
      { sessionId: "t3" },
    );

    const events = await collectEvents(thread.run("solve this"));

    const thinkingEvents = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingEvents).toHaveLength(2);
    expect(thinkingEvents[0]).toEqual({
      type: "thinking_delta",
      text: "Let me think...",
    });
    expect(thinkingEvents[1]).toEqual({
      type: "thinking_delta",
      text: " about this.",
    });

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toEqual({
      type: "text_delta",
      text: "Here is the answer.",
    });
  });

  it("handles thinking disabled config", async () => {
    provider.addResponse([textChunk("hello"), stopChunk()]);

    const thread = new Thread(
      {
        ...baseConfig,
        thinking: { type: "disabled" },
      },
      { sessionId: "t4" },
    );

    const events = await collectEvents(thread.run("hi"));

    expect(provider.calls[0].thinking).toEqual({ type: "disabled" });
    const thinkingEvents = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingEvents).toHaveLength(0);
  });
});
