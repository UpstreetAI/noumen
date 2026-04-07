import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  finalizeLoopExit,
  finalizeTurn,
  type FinalizeLoopExitParams,
  type FinalizeTurnParams,
} from "../pipeline/finalize-turn.js";
import { createAccumulator, type StreamAccumulator } from "../pipeline/consume-stream.js";
import { MockFs } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import { NoopTracer } from "../tracing/noop.js";
import type { AssistantMessage, ChatMessage, StreamEvent } from "../session/types.js";
import type { ChatCompletionUsage, OutputFormat } from "../providers/types.js";

vi.mock("../memory/extraction.js", () => ({
  extractMemories: vi.fn(),
}));
const { extractMemories: mockExtractMemories } = await import("../memory/extraction.js");

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

function makeAccumulator(content?: string[]): StreamAccumulator {
  const acc = createAccumulator();
  if (content) {
    acc.content.push(...content);
  }
  return acc;
}

function makeAssistantMsg(content = "Hello"): AssistantMessage {
  return { role: "assistant", content };
}

function makeLoopExitParams(overrides?: Partial<FinalizeLoopExitParams>): FinalizeLoopExitParams {
  const fs = new MockFs();
  const storage = new SessionStorage(fs, "/sessions");
  return {
    accumulator: makeAccumulator(["Hello"]),
    assistantMsg: makeAssistantMsg(),
    outputFormat: undefined,
    isFinalResponseMode: false,
    turnUsage: makeUsage(),
    model: "test-model",
    callCount: 1,
    sessionId: "test-session",
    costTracker: undefined,
    hooks: [],
    storage,
    ...overrides,
  };
}

function makeTeardownParams(overrides?: Partial<FinalizeTurnParams>): FinalizeTurnParams {
  const tracer = new NoopTracer();
  const interactionSpan = tracer.startSpan("test");
  return {
    signal: new AbortController().signal,
    memoryConfig: undefined,
    provider: { chat: vi.fn() } as never,
    model: "test-model",
    messages: [{ role: "user", content: "Hi" }],
    sessionId: "test-session",
    callCount: 1,
    maxTurns: undefined,
    hooks: [],
    interactionSpan,
    interactionStart: Date.now(),
    ...overrides,
  };
}

describe("finalizeLoopExit", () => {
  it("emits message_complete and turn_complete events", async () => {
    const result = await finalizeLoopExit(makeLoopExitParams());

    const msgComplete = result.events.filter((e) => e.type === "message_complete");
    expect(msgComplete).toHaveLength(1);

    const turnComplete = result.events.filter((e) => e.type === "turn_complete");
    expect(turnComplete).toHaveLength(1);
  });

  it("emits structured_output for alongside_tools mode when text is valid JSON", async () => {
    const outputFormat: OutputFormat = {
      type: "json_schema",
      schema: { type: "object" },
      name: "TestSchema",
    };

    const result = await finalizeLoopExit(makeLoopExitParams({
      accumulator: makeAccumulator(['{"answer":42}']),
      outputFormat,
      isFinalResponseMode: false,
    }));

    const soEvents = result.events.filter((e) => e.type === "structured_output");
    expect(soEvents).toHaveLength(1);
    expect((soEvents[0] as { data: unknown }).data).toEqual({ answer: 42 });
  });

  it("does not emit structured_output for alongside_tools mode when text is not JSON", async () => {
    const outputFormat: OutputFormat = {
      type: "json_schema",
      schema: { type: "object" },
      name: "TestSchema",
    };

    const result = await finalizeLoopExit(makeLoopExitParams({
      accumulator: makeAccumulator(["Not JSON"]),
      outputFormat,
      isFinalResponseMode: false,
    }));

    const soEvents = result.events.filter((e) => e.type === "structured_output");
    expect(soEvents).toHaveLength(0);
  });

  it("does not emit structured_output in final_response mode", async () => {
    const result = await finalizeLoopExit(makeLoopExitParams({
      accumulator: makeAccumulator(['{"answer":42}']),
      outputFormat: { type: "json_schema", schema: { type: "object" } },
      isFinalResponseMode: true,
    }));

    const soEvents = result.events.filter((e) => e.type === "structured_output");
    expect(soEvents).toHaveLength(0);
  });

  it("persists cost state when costTracker is provided", async () => {
    const costTracker = {
      getState: vi.fn().mockReturnValue({ byModel: {}, totalApiMs: 0, wallStartMs: 0 }),
    } as never;
    const fs = new MockFs();
    const storage = new SessionStorage(fs, "/sessions");
    const appendSpy = vi.spyOn(storage, "appendMetadata").mockResolvedValue();

    await finalizeLoopExit(makeLoopExitParams({ costTracker, storage }));

    expect(appendSpy).toHaveBeenCalledWith("test-session", "costState", expect.any(Object));
  });
});

describe("finalizeTurn (post-loop teardown)", () => {
  beforeEach(() => {
    vi.mocked(mockExtractMemories).mockReset();
  });

  it("returns earlyReturn when signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await finalizeTurn(makeTeardownParams({ signal: ac.signal }));

    expect(result.earlyReturn).toBe(true);
    const spanEnd = result.events.filter((e) => e.type === "span_end");
    expect(spanEnd).toHaveLength(1);
  });

  it("emits span_end and does not earlyReturn on normal path", async () => {
    const result = await finalizeTurn(makeTeardownParams());

    expect(result.earlyReturn).toBe(false);
    const spanEnd = result.events.filter((e) => e.type === "span_end");
    expect(spanEnd).toHaveLength(1);
  });

  it("runs memory extraction when configured", async () => {
    vi.mocked(mockExtractMemories).mockResolvedValueOnce({
      created: [{ name: "mem1", description: "desc", type: "user", content: "new memory", path: "/m/1.md" }],
      updated: [],
      deleted: [],
    });

    const memoryProvider = {
      loadIndex: vi.fn(),
      loadEntry: vi.fn(),
      saveEntry: vi.fn(),
      removeEntry: vi.fn(),
      listEntries: vi.fn(),
      search: vi.fn(),
    };

    const result = await finalizeTurn(makeTeardownParams({
      memoryConfig: { provider: memoryProvider, autoExtract: true },
    }));

    expect(vi.mocked(mockExtractMemories)).toHaveBeenCalled();
    const memEvents = result.events.filter((e) => e.type === "memory_update");
    expect(memEvents).toHaveLength(1);
  });

  it("skips memory extraction when no changes", async () => {
    vi.mocked(mockExtractMemories).mockResolvedValueOnce({
      created: [],
      updated: [],
      deleted: [],
    });

    const memoryProvider = {
      loadIndex: vi.fn(),
      loadEntry: vi.fn(),
      saveEntry: vi.fn(),
      removeEntry: vi.fn(),
      listEntries: vi.fn(),
      search: vi.fn(),
    };

    const result = await finalizeTurn(makeTeardownParams({
      memoryConfig: { provider: memoryProvider, autoExtract: true },
    }));

    const memEvents = result.events.filter((e) => e.type === "memory_update");
    expect(memEvents).toHaveLength(0);
  });

  it("handles memory extraction errors gracefully", async () => {
    vi.mocked(mockExtractMemories).mockRejectedValueOnce(new Error("extraction failed"));

    const memoryProvider = {
      loadIndex: vi.fn(),
      loadEntry: vi.fn(),
      saveEntry: vi.fn(),
      removeEntry: vi.fn(),
      listEntries: vi.fn(),
      search: vi.fn(),
    };

    const result = await finalizeTurn(makeTeardownParams({
      memoryConfig: { provider: memoryProvider, autoExtract: true },
    }));

    expect(result.earlyReturn).toBe(false);
    const memEvents = result.events.filter((e) => e.type === "memory_update");
    expect(memEvents).toHaveLength(0);
  });

  it("skips memory extraction when autoExtract is false", async () => {
    const memoryProvider = {
      loadIndex: vi.fn(),
      loadEntry: vi.fn(),
      saveEntry: vi.fn(),
      removeEntry: vi.fn(),
      listEntries: vi.fn(),
      search: vi.fn(),
    };

    await finalizeTurn(makeTeardownParams({
      memoryConfig: { provider: memoryProvider, autoExtract: false },
    }));

    expect(vi.mocked(mockExtractMemories)).not.toHaveBeenCalled();
  });
});
