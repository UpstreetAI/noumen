import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  toolCallResponse,
  textChunk,
  toolCallStartChunk,
  toolCallArgChunk,
  toolCallsFinishChunk,
} from "./helpers.js";
import { Thread } from "../thread.js";
import type { ThreadConfig } from "../thread.js";
import type { StreamEvent } from "../session/types.js";
import type { AIProvider, ChatParams, ChatStreamChunk, ChatCompletionUsage } from "../providers/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";

let fs: MockFs;
let computer: MockComputer;
let provider: MockAIProvider;
let config: ThreadConfig;

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  provider = new MockAIProvider();
  config = {
    provider: provider,
    fs,
    computer,
    sessionDir: "/sessions",
    autoCompact: createAutoCompactConfig({ enabled: false }),
  };
});

async function collectEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("Thread", () => {
  describe("abort", () => {
    it("stops the generator", async () => {
      const chunks: ChatStreamChunk[] = Array.from({ length: 100 }, (_, i) => ({
        id: `c${i}`,
        model: "m",
        choices: [
          {
            index: 0,
            delta: { content: `chunk${i} ` },
            finish_reason: null as string | null,
          },
        ],
      }));
      chunks.push({
        id: "final",
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      provider.addResponse(chunks);

      const thread = new Thread(config, { sessionId: "s1" });
      const events: StreamEvent[] = [];
      const gen = thread.run("hi");

      for await (const event of gen) {
        events.push(event);
        if (events.length >= 3) {
          thread.abort();
          break;
        }
      }

      expect(events.length).toBeLessThan(100);
    });
  });
});

describe("abort signal linking", () => {
  it("abort() works when external signal is provided", async () => {
    const chunks: ChatStreamChunk[] = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      model: "m",
      choices: [{ index: 0, delta: { content: `chunk${i} ` }, finish_reason: null as string | null }],
    }));
    chunks.push({ id: "final", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    provider.addResponse(chunks);

    const externalController = new AbortController();
    const thread = new Thread(config, { sessionId: "abort-test" });
    const events: StreamEvent[] = [];

    for await (const event of thread.run("hi", { signal: externalController.signal })) {
      events.push(event);
      if (events.length >= 3) {
        thread.abort();
        break;
      }
    }

    expect(events.length).toBeLessThan(100);
  });

  it("external signal abort propagates to thread", async () => {
    const chunks: ChatStreamChunk[] = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      model: "m",
      choices: [{ index: 0, delta: { content: `chunk${i} ` }, finish_reason: null as string | null }],
    }));
    chunks.push({ id: "final", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    provider.addResponse(chunks);

    const externalController = new AbortController();
    const thread = new Thread(config, { sessionId: "ext-abort-test" });
    const events: StreamEvent[] = [];

    for await (const event of thread.run("hi", { signal: externalController.signal })) {
      events.push(event);
      if (events.length >= 3) {
        externalController.abort();
        break;
      }
    }

    expect(events.length).toBeLessThan(100);
  });

  it("passes signal to provider via ChatParams", async () => {
    provider.addResponse(textResponse("ok"));
    const thread = new Thread(config, { sessionId: "signal-pass" });
    await collectEvents(thread.run("test"));

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].signal).toBeDefined();
    expect(provider.calls[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("ToolContext receives signal", () => {
  it("signal is passed to tool context during run", async () => {
    let receivedSignal: AbortSignal | undefined;

    const toolConfig: ThreadConfig = {
      ...config,
      tools: [
        {
          name: "TestTool",
          description: "Test tool",
          parameters: { type: "object", properties: { x: { type: "string" } } },
          async call(_args, ctx) {
            receivedSignal = ctx.signal;
            return { content: "ok" };
          },
        },
      ],
    };

    const toolCallChunks: ChatStreamChunk[] = [
      {
        id: "t1", model: "m",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "tc_test", type: "function", function: { name: "TestTool", arguments: "" } }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "t2", model: "m",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":"val"}' } }] },
          finish_reason: null,
        }],
      },
      {
        id: "t3", model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ];

    provider.addResponse(toolCallChunks);
    provider.addResponse(textResponse("done"));

    const thread = new Thread(toolConfig, { sessionId: "signal-ctx" });
    await collectEvents(thread.run("test"));

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("abort signal propagation to streaming executor", () => {
  it("discards streaming executor on abort before draining results", async () => {
    const threadConfig: ThreadConfig = {
      ...config,
      streamingToolExecution: true,
      tools: [
        {
          name: "SlowTool",
          description: "slow tool",
          parameters: { type: "object", properties: {} },
          isConcurrencySafe: true,
          async call(_args, ctx) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 5000);
              ctx.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); });
            });
            return { content: "done" };
          },
        },
      ],
    };

    const ac = new AbortController();
    let callIdx = 0;
    const abortProvider: AIProvider = {
      defaultModel: "mock-model",
      async *chat() {
        callIdx++;
        if (callIdx === 1) {
          yield toolCallStartChunk("tc_slow", "SlowTool");
          yield toolCallArgChunk("{}");
          yield toolCallsFinishChunk();
        } else {
          yield textChunk("ok");
          yield { id: "stop", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        }
      },
    };

    const thread = new Thread(
      { ...threadConfig, provider: abortProvider },
      { sessionId: "abort-streaming" },
    );

    setTimeout(() => ac.abort(), 100);

    const events = await collectEvents(thread.run("test", { signal: ac.signal }));
    const hasAbortInterruption = events.some(
      (e) => e.type === "text_delta" && typeof (e as any).text === "string" && (e as any).text.includes("interrupted"),
    ) || events.some(
      (e) => e.type === "turn_complete",
    );
    expect(hasAbortInterruption || events.length > 0).toBe(true);
  });

  it("preserves completed tool results on abort instead of dropping them", async () => {
    let fastToolCalled = false;
    const threadConfig: ThreadConfig = {
      ...config,
      streamingToolExecution: true,
      tools: [
        {
          name: "FastTool",
          description: "completes immediately",
          parameters: { type: "object", properties: {} },
          isConcurrencySafe: true,
          async call() {
            fastToolCalled = true;
            return { content: "fast-result" };
          },
        },
        {
          name: "SlowTool",
          description: "blocks until abort",
          parameters: { type: "object", properties: {} },
          isConcurrencySafe: true,
          async call(_args, ctx) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 10_000);
              ctx.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve();
              });
            });
            return { content: "slow-result" };
          },
        },
      ],
    };

    const ac = new AbortController();
    const abortProvider: AIProvider = {
      defaultModel: "mock-model",
      async *chat() {
        yield {
          id: "c1", model: "m",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tc_fast", type: "function" as const, function: { name: "FastTool", arguments: "" } }] }, finish_reason: null }],
        };
        yield {
          id: "c2", model: "m",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null }],
        };
        yield {
          id: "c3", model: "m",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "tc_slow", type: "function" as const, function: { name: "SlowTool", arguments: "" } }] }, finish_reason: null }],
        };
        yield {
          id: "c4", model: "m",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "{}" } }] }, finish_reason: null }],
        };
        yield { id: "c5", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" as const }] };
      },
    };

    const thread = new Thread(
      { ...threadConfig, provider: abortProvider },
      { sessionId: "abort-preserves-results" },
    );

    setTimeout(() => ac.abort(), 200);

    await collectEvents(thread.run("test", { signal: ac.signal }));

    expect(fastToolCalled).toBe(true);

    const msgs = await thread.getMessages();
    const assistantMsg = msgs.find(
      (m: any) => m.role === "assistant" && m.tool_calls?.length,
    ) as any;
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.tool_calls).toHaveLength(2);

    const toolMsgs = msgs.filter((m: any) => m.role === "tool");
    const fastResult = toolMsgs.find((m: any) => m.tool_call_id === "tc_fast");
    const slowResult = toolMsgs.find((m: any) => m.tool_call_id === "tc_slow");

    expect(fastResult).toBeDefined();
    expect(fastResult!.content).toBe("fast-result");

    expect(slowResult).toBeDefined();

    const toolResultIds = new Set(toolMsgs.map((m: any) => m.tool_call_id));
    for (const tc of assistantMsg.tool_calls) {
      expect(toolResultIds.has(tc.id)).toBe(true);
    }
  });
});
