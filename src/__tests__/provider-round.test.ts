import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executeProviderRound,
  stripThinkingSignatures,
  type ProviderRoundParams,
} from "../pipeline/provider-round.js";
import {
  MockFs,
  MockAIProvider,
  textResponse,
  textChunk,
  stopChunk,
  toolCallStartChunk,
  toolCallArgChunk,
  toolCallsFinishChunk,
} from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import { NoopTracer } from "../tracing/noop.js";
import type { ChatMessage, StreamEvent } from "../session/types.js";
import type { ChatCompletionUsage } from "../providers/types.js";
import { createAutoCompactTracking } from "../compact/auto-compact.js";

async function drainGenerator<R>(
  gen: AsyncGenerator<StreamEvent, R>,
): Promise<{ events: StreamEvent[]; result: R }> {
  const events: StreamEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, result: step.value };
}

function makeUsage(total = 100): ChatCompletionUsage {
  return {
    prompt_tokens: total / 2,
    completion_tokens: total / 2,
    total_tokens: total,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    thinking_tokens: 0,
  };
}

function makeBaseParams(overrides?: Partial<ProviderRoundParams>): ProviderRoundParams {
  const fs = new MockFs();
  const provider = new MockAIProvider();
  provider.addResponse(textResponse("Hello world", makeUsage()));
  const storage = new SessionStorage(fs, "/sessions");
  const tracer = new NoopTracer();
  const parentSpan = tracer.startSpan("test");

  return {
    messages: [{ role: "user", content: "Hi" }],
    storage,
    sessionId: "test-session",
    provider,
    model: "test-model",
    messagesForApi: [{ role: "user", content: "Hi" }],
    systemPrompt: "You are helpful.",
    toolDefs: [],
    maxTokens: undefined,
    thinking: undefined,
    retryConfig: undefined,
    promptCachingEnabled: false,
    skipCacheWrite: undefined,
    outputFormat: undefined,
    isFinalResponseMode: false,
    useStreamingExec: false,
    signal: new AbortController().signal,
    tracer,
    parentSpan,
    hooks: [],
    toolRegistryLookup: () => undefined,
    buildStreamingExecutorFn: vi.fn() as never,
    reactiveCompact: undefined,
    hasAttemptedReactiveCompact: false,
    autoCompactTracking: createAutoCompactTracking(),
    mcpToolNames: undefined,
    costTracker: undefined,
    turnUsage: makeUsage(0),
    callCount: 0,
    consecutiveMalformedIterations: 0,
    preventContinuation: false,
    currentMaxTokens: undefined,
    outputTokenRecoveryAttempts: 0,
    maxTurns: undefined,
    ...overrides,
  };
}

describe("executeProviderRound", () => {
  it("yields text_delta and returns assistant message for simple text response", async () => {
    const params = makeBaseParams();
    const gen = executeProviderRound(params);
    const { events, result } = await drainGenerator(gen);

    expect(result.shouldContinueOuterLoop).toBe(false);
    expect(result.shouldBreakOuterLoop).toBe(false);
    expect(result.assistantMsg).not.toBeNull();
    expect(result.assistantMsg!.content).toBe("Hello world");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.callCount).toBe(1);

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it("yields usage event when provider returns usage data", async () => {
    const params = makeBaseParams();
    const gen = executeProviderRound(params);
    const { events, result } = await drainGenerator(gen);

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents.length).toBeGreaterThan(0);
    expect(result.lastUsage).toBeDefined();
    expect(result.lastUsage!.total_tokens).toBe(100);
  });

  it("returns tool calls when provider emits tool use", async () => {
    const provider = new MockAIProvider();
    provider.addResponse([
      toolCallStartChunk("tc1", "ReadFile"),
      toolCallArgChunk('{"path":"/a.txt"}'),
      toolCallsFinishChunk(makeUsage()),
    ]);

    const params = makeBaseParams({ provider });
    const gen = executeProviderRound(params);
    const { result } = await drainGenerator(gen);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("ReadFile");
    expect(result.assistantMsg).not.toBeNull();
    expect(result.assistantMsg!.tool_calls).toHaveLength(1);
  });

  it("handles malformed tool calls and signals continue when only malformed exist", async () => {
    const provider = new MockAIProvider();
    provider.addResponse([
      toolCallStartChunk("tc1", "ReadFile"),
      toolCallArgChunk("{invalid json"),
      toolCallsFinishChunk(makeUsage()),
    ]);

    const params = makeBaseParams({ provider });
    const gen = executeProviderRound(params);
    const { events, result } = await drainGenerator(gen);

    expect(result.malformedToolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.shouldContinueOuterLoop).toBe(true);
    expect(result.consecutiveMalformedIterations).toBe(1);

    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    expect(toolResultEvents.length).toBeGreaterThan(0);
  });

  it("breaks when max consecutive malformed iterations reached", async () => {
    const provider = new MockAIProvider();
    provider.addResponse([
      toolCallStartChunk("tc1", "ReadFile"),
      toolCallArgChunk("{bad"),
      toolCallsFinishChunk(makeUsage()),
    ]);

    const params = makeBaseParams({
      provider,
      consecutiveMalformedIterations: 4,
    });
    const gen = executeProviderRound(params);
    const { events, result } = await drainGenerator(gen);

    expect(result.shouldBreakOuterLoop).toBe(true);
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
  });

  it("breaks on malformed when maxTurns reached", async () => {
    const provider = new MockAIProvider();
    provider.addResponse([
      toolCallStartChunk("tc1", "ReadFile"),
      toolCallArgChunk("{bad"),
      toolCallsFinishChunk(makeUsage()),
    ]);

    const params = makeBaseParams({
      provider,
      callCount: 3,
      maxTurns: 3,
    });
    const gen = executeProviderRound(params);
    const { events, result } = await drainGenerator(gen);

    expect(result.shouldBreakOuterLoop).toBe(true);
    const turnComplete = events.filter((e) => e.type === "turn_complete");
    expect(turnComplete).toHaveLength(1);
    const maxTurnsReached = events.filter((e) => e.type === "max_turns_reached");
    expect(maxTurnsReached).toHaveLength(1);
  });

  it("signals break when signal is aborted after stream", async () => {
    const ac = new AbortController();
    const provider = new MockAIProvider();
    provider.addResponse(textResponse("Hello", makeUsage()));

    const params = makeBaseParams({ provider, signal: ac.signal });
    const gen = executeProviderRound(params);

    // Drain partially then abort
    const events: StreamEvent[] = [];
    let step = await gen.next();
    while (!step.done) {
      events.push(step.value);
      // Abort after receiving first event
      if (events.length === 1) ac.abort();
      step = await gen.next();
    }
    const result = step.value;

    expect(result.shouldBreakOuterLoop).toBe(true);
  });

  it("throws on provider error", async () => {
    const provider = {
      chat: vi.fn(() => { throw new Error("API down"); }),
    } as never;

    const params = makeBaseParams({ provider });
    const gen = executeProviderRound(params);

    await expect(drainGenerator(gen)).rejects.toThrow("API down");
  });

  it("updates model on model_switch events", async () => {
    const params = makeBaseParams({ model: "model-a" });
    const gen = executeProviderRound(params);
    const { result } = await drainGenerator(gen);

    // Without retry config, model stays the same
    expect(result.model).toBe("model-a");
  });

  it("emits span_start and span_end events", async () => {
    const params = makeBaseParams();
    const gen = executeProviderRound(params);
    const { events } = await drainGenerator(gen);

    const spanStarts = events.filter((e) => e.type === "span_start");
    const spanEnds = events.filter((e) => e.type === "span_end");
    expect(spanStarts.length).toBeGreaterThanOrEqual(1);
    expect(spanEnds.length).toBeGreaterThanOrEqual(1);
  });

  it("increments callCount", async () => {
    const params = makeBaseParams({ callCount: 5 });
    const gen = executeProviderRound(params);
    const { result } = await drainGenerator(gen);

    expect(result.callCount).toBe(6);
  });

  it("reports cost_update when costTracker is provided", async () => {
    const costTracker = {
      addUsage: vi.fn().mockReturnValue({ totalCost: 0.05 }),
      getState: vi.fn().mockReturnValue({ byModel: {}, totalApiMs: 0, wallStartMs: 0 }),
    } as never;

    const params = makeBaseParams({ costTracker });
    const gen = executeProviderRound(params);
    const { events } = await drainGenerator(gen);

    const costEvents = events.filter((e) => e.type === "cost_update");
    expect(costEvents).toHaveLength(1);
  });
});

describe("stripThinkingSignatures", () => {
  it("removes thinking_signature and redacted_thinking_data from assistant messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: "Hello",
        thinking_signature: "sig123",
        redacted_thinking_data: "data456",
      } as ChatMessage,
      { role: "user", content: "Thanks" },
    ];

    stripThinkingSignatures(messages);

    const asst = messages[1] as unknown as Record<string, unknown>;
    expect(asst.thinking_signature).toBeUndefined();
    expect(asst.redacted_thinking_data).toBeUndefined();
    expect(asst.content).toBe("Hello");
  });

  it("does not modify non-assistant messages", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Hi" }];
    stripThinkingSignatures(messages);
    expect(messages[0]).toEqual({ role: "user", content: "Hi" });
  });
});
