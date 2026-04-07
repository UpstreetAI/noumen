import { describe, it, expect, vi } from "vitest";
import {
  createAccumulator,
  resetAccumulator,
  consumeStream,
  handleFinishReason,
  type StreamAccumulator,
} from "../pipeline/consume-stream.js";
import type { ChatStreamChunk } from "../providers/types.js";
import type { StreamEvent } from "../session/types.js";
import type { StreamingExecResult } from "../tools/streaming-executor.js";

function makeChunk(overrides: Partial<ChatStreamChunk> & { choices?: ChatStreamChunk["choices"] }): ChatStreamChunk {
  return {
    id: "chunk-1",
    model: "test-model",
    choices: [],
    ...overrides,
  };
}

function makeDeltaChunk(delta: Record<string, unknown>, finishReason: string | null = null): ChatStreamChunk {
  return makeChunk({
    choices: [{ index: 0, delta: delta as any, finish_reason: finishReason }],
  });
}

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const evt of gen) {
    events.push(evt);
  }
  return events;
}

async function* asyncFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

describe("consumeStream", () => {
  it("accumulates text content and yields text_delta events", async () => {
    const acc = createAccumulator();
    const stream = asyncFrom([
      makeDeltaChunk({ content: "Hello " }),
      makeDeltaChunk({ content: "world" }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const events = await collectEvents(consumeStream(stream, acc, null, [], new AbortController().signal));

    expect(acc.content).toEqual(["Hello ", "world"]);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "Hello " });
    expect(events[1]).toEqual({ type: "text_delta", text: "world" });
  });

  it("accumulates thinking content and yields thinking_delta events", async () => {
    const acc = createAccumulator();
    const stream = asyncFrom([
      makeDeltaChunk({ thinking_content: "Let me think..." }),
      makeDeltaChunk({ thinking_signature: "sig-part1" }),
      makeDeltaChunk({ thinking_signature: "sig-part2" }),
      makeDeltaChunk({ redacted_thinking_data: "redacted-data" }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const events = await collectEvents(consumeStream(stream, acc, null, [], new AbortController().signal));

    expect(acc.thinking).toEqual(["Let me think..."]);
    expect(acc.thinkingSignature).toBe("sig-part1sig-part2");
    expect(acc.redactedThinkingData).toBe("redacted-data");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "thinking_delta", text: "Let me think..." });
  });

  it("assembles a single tool call from multiple chunks", async () => {
    const acc = createAccumulator();
    const stream = asyncFrom([
      makeDeltaChunk({
        tool_calls: [{ index: 0, id: "tc_1", type: "function", function: { name: "ReadFile", arguments: '{"pa' } }],
      }),
      makeDeltaChunk({
        tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }],
      }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const events = await collectEvents(consumeStream(stream, acc, null, [], new AbortController().signal));

    expect(acc.toolCalls.size).toBe(1);
    const tc = acc.toolCalls.get(0)!;
    expect(tc.id).toBe("tc_1");
    expect(tc.name).toBe("ReadFile");
    expect(tc.arguments).toBe('{"path":"a.txt"}');
    expect(events[0]).toEqual({ type: "tool_use_start", toolName: "ReadFile", toolUseId: "tc_1" });
    expect(events[1]).toEqual({ type: "tool_use_delta", input: 'th":"a.txt"}' });
  });

  it("emits tool_use_start only after both id and name are known (late delivery)", async () => {
    const acc = createAccumulator();
    const stream = asyncFrom([
      makeDeltaChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }],
      }),
      makeDeltaChunk({
        tool_calls: [{ index: 0, id: "tc_late", function: { name: "Bash" } }],
      }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const events = await collectEvents(consumeStream(stream, acc, null, [], new AbortController().signal));

    const startEvent = events.find((e) => e.type === "tool_use_start");
    expect(startEvent).toBeDefined();
    expect((startEvent as any).toolName).toBe("Bash");
    expect((startEvent as any).toolUseId).toBe("tc_late");
  });

  it("dispatches previous tool to streaming executor when next tool starts", async () => {
    const acc = createAccumulator();
    const mockExec = {
      addTool: vi.fn(),
      getCompletedResults: vi.fn().mockReturnValue([]),
      discard: vi.fn(),
    };

    const stream = asyncFrom([
      makeDeltaChunk({
        tool_calls: [{ index: 0, id: "tc_0", type: "function", function: { name: "ReadFile", arguments: '{"path":"a.txt"}' } }],
      }),
      makeDeltaChunk({
        tool_calls: [{ index: 1, id: "tc_1", type: "function", function: { name: "WriteFile", arguments: '{}' } }],
      }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    await collectEvents(consumeStream(stream, acc, mockExec as any, [], new AbortController().signal));

    expect(mockExec.addTool).toHaveBeenCalledTimes(1);
    expect(mockExec.addTool.mock.calls[0][0].id).toBe("tc_0");
    expect(acc.toolCalls.get(0)!.complete).toBe(true);
  });

  it("respects abort signal and stops iteration early", async () => {
    const acc = createAccumulator();
    const controller = new AbortController();
    controller.abort();

    const stream = asyncFrom([
      makeDeltaChunk({ content: "Should not appear" }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const events = await collectEvents(consumeStream(stream, acc, null, [], controller.signal));

    expect(events).toHaveLength(0);
    expect(acc.content).toHaveLength(0);
  });

  it("accumulates usage and finish_reason from the final chunk", async () => {
    const acc = createAccumulator();
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    const stream = asyncFrom([
      makeDeltaChunk({ content: "hi" }, "stop"),
      makeChunk({ usage }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    await collectEvents(consumeStream(stream, acc, null, [], new AbortController().signal));

    expect(acc.finishReason).toBe("stop");
    expect(acc.usage).toEqual(usage);
  });

  it("drains completed streaming results after iteration", async () => {
    const acc = createAccumulator();
    const fakeResult: StreamingExecResult = {
      toolCall: { id: "tc_0", type: "function", function: { name: "Bash", arguments: "{}" } },
      parsedArgs: {},
      result: { content: "done" },
      events: [],
    };
    const mockExec = {
      addTool: vi.fn(),
      getCompletedResults: vi.fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([fakeResult]),
      discard: vi.fn(),
    };

    const stream = asyncFrom([
      makeDeltaChunk({ content: "a" }),
      makeDeltaChunk({ content: "b" }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const results: StreamingExecResult[] = [];
    await collectEvents(consumeStream(stream, acc, mockExec as any, results, new AbortController().signal));

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(fakeResult);
  });
});

describe("resetAccumulator", () => {
  it("clears all accumulated state", () => {
    const acc = createAccumulator();
    acc.content.push("text");
    acc.thinking.push("think");
    acc.thinkingSignature = "sig";
    acc.redactedThinkingData = "data";
    acc.toolCalls.set(0, { id: "tc", name: "Bash", arguments: "{}", complete: false });
    acc.finishReason = "stop";
    acc.usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };

    resetAccumulator(acc);

    expect(acc.content).toHaveLength(0);
    expect(acc.thinking).toHaveLength(0);
    expect(acc.thinkingSignature).toBeUndefined();
    expect(acc.redactedThinkingData).toBeUndefined();
    expect(acc.toolCalls.size).toBe(0);
    expect(acc.finishReason).toBeNull();
    expect(acc.usage).toBeUndefined();
  });
});

describe("handleFinishReason", () => {
  function makeAcc(overrides: Partial<StreamAccumulator> = {}): StreamAccumulator {
    return { ...createAccumulator(), ...overrides };
  }

  it("returns no-op result for normal stop", () => {
    const acc = makeAcc({ finishReason: "stop" });
    const result = handleFinishReason(acc, null, [], undefined, 0, new AbortController().signal);

    expect(result.events).toHaveLength(0);
    expect(result.messagesToPersist).toHaveLength(0);
    expect(result.preventContinuation).toBe(false);
    expect(result.shouldContinue).toBe(false);
    expect(result.escalateMaxTokens).toBeUndefined();
  });

  it("escalates max tokens on first length truncation with default tokens", () => {
    const acc = makeAcc({ finishReason: "length", content: ["partial text"] });
    const result = handleFinishReason(acc, null, [], undefined, 0, new AbortController().signal);

    expect(result.shouldContinue).toBe(true);
    expect(result.escalateMaxTokens).toBe(65536);
    expect(result.messagesToPersist).toHaveLength(2);
    expect(result.messagesToPersist[0].role).toBe("assistant");
    expect((result.messagesToPersist[0] as any).content).toBe("partial text");
    expect(result.messagesToPersist[1].role).toBe("user");
    expect((result.messagesToPersist[1] as any).content).toContain("Continue");
  });

  it("continues without escalation on subsequent length truncation attempts", () => {
    const acc = makeAcc({ finishReason: "length", content: ["more text"] });
    const result = handleFinishReason(acc, null, [], 65536, 1, new AbortController().signal);

    expect(result.shouldContinue).toBe(true);
    expect(result.escalateMaxTokens).toBeUndefined();
    expect(result.messagesToPersist).toHaveLength(2);
  });

  it("gives up after max recovery attempts", () => {
    const acc = makeAcc({ finishReason: "length" });
    const result = handleFinishReason(acc, null, [], 65536, 3, new AbortController().signal);

    expect(result.shouldContinue).toBe(false);
    expect(result.events).toHaveLength(1);
    expect((result.events[0] as any).text).toContain("[Response truncated");
  });

  it("does not trigger length recovery when tool calls exist", () => {
    const toolCalls = new Map<number, any>();
    toolCalls.set(0, { id: "tc_1", name: "Bash", arguments: "{}", complete: true });
    const acc = makeAcc({ finishReason: "length", toolCalls });
    const result = handleFinishReason(acc, null, [], undefined, 0, new AbortController().signal);

    expect(result.shouldContinue).toBe(false);
    expect(result.escalateMaxTokens).toBeUndefined();
  });

  it("handles content_filter with streaming exec", () => {
    const fakeResult: StreamingExecResult = {
      toolCall: { id: "tc_0", type: "function", function: { name: "Bash", arguments: "{}" } },
      parsedArgs: {},
      result: { content: "done" },
      events: [],
    };
    const mockExec = {
      addTool: vi.fn(),
      getCompletedResults: vi.fn().mockReturnValue([fakeResult]),
      discard: vi.fn(),
    };
    const streamingResults: StreamingExecResult[] = [];
    const acc = makeAcc({ finishReason: "content_filter" });
    const result = handleFinishReason(acc, mockExec as any, streamingResults, undefined, 0, new AbortController().signal);

    expect(result.preventContinuation).toBe(true);
    expect(result.events).toHaveLength(1);
    expect((result.events[0] as any).text).toContain("content filter");
    expect(mockExec.discard).toHaveBeenCalled();
    expect(streamingResults).toHaveLength(1);
  });

  it("handles content_filter without streaming exec by clearing tool calls", () => {
    const toolCalls = new Map<number, any>();
    toolCalls.set(0, { id: "tc_1", name: "Bash", arguments: "{}", complete: false });
    const acc = makeAcc({ finishReason: "content_filter", toolCalls });
    const result = handleFinishReason(acc, null, [], undefined, 0, new AbortController().signal);

    expect(result.events).toHaveLength(1);
    expect(acc.toolCalls.size).toBe(0);
  });

  it("flushes remaining incomplete tools to streaming executor", () => {
    const toolCalls = new Map<number, any>();
    toolCalls.set(0, { id: "tc_0", name: "ReadFile", arguments: '{"path":"a.txt"}', complete: false });
    toolCalls.set(1, { id: "tc_1", name: "WriteFile", arguments: '{"path":"b.txt","content":"hi"}', complete: false });
    const mockExec = {
      addTool: vi.fn(),
      getCompletedResults: vi.fn().mockReturnValue([]),
      discard: vi.fn(),
    };
    const acc = makeAcc({ finishReason: "stop", toolCalls });

    handleFinishReason(acc, mockExec as any, [], undefined, 0, new AbortController().signal);

    expect(mockExec.addTool).toHaveBeenCalledTimes(2);
    expect(toolCalls.get(0)!.complete).toBe(true);
    expect(toolCalls.get(1)!.complete).toBe(true);
  });

  it("marks malformed tool calls when JSON.parse fails", () => {
    const toolCalls = new Map<number, any>();
    toolCalls.set(0, { id: "tc_0", name: "Bash", arguments: "not-json", complete: false });
    const mockExec = {
      addTool: vi.fn(),
      getCompletedResults: vi.fn().mockReturnValue([]),
      discard: vi.fn(),
    };
    const acc = makeAcc({ finishReason: "stop", toolCalls });

    handleFinishReason(acc, mockExec as any, [], undefined, 0, new AbortController().signal);

    expect(toolCalls.get(0)!.malformedJson).toBe(true);
    expect(mockExec.addTool).not.toHaveBeenCalled();
  });

  it("does not flush tools when signal is aborted", () => {
    const toolCalls = new Map<number, any>();
    toolCalls.set(0, { id: "tc_0", name: "Bash", arguments: '{}', complete: false });
    const mockExec = {
      addTool: vi.fn(),
      getCompletedResults: vi.fn().mockReturnValue([]),
      discard: vi.fn(),
    };
    const controller = new AbortController();
    controller.abort();
    const acc = makeAcc({ finishReason: "stop", toolCalls });

    handleFinishReason(acc, mockExec as any, [], undefined, 0, controller.signal);

    expect(mockExec.addTool).not.toHaveBeenCalled();
    expect(toolCalls.get(0)!.complete).toBe(false);
  });

  it("does not persist empty content for length recovery", () => {
    const acc = makeAcc({ finishReason: "length" });
    const result = handleFinishReason(acc, null, [], undefined, 0, new AbortController().signal);

    expect(result.shouldContinue).toBe(true);
    expect(result.messagesToPersist).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case tests for consume-stream
// ---------------------------------------------------------------------------

describe("consumeStream edge cases", () => {
  it("handles non-contiguous tool indices (index 0, then index 2)", async () => {
    const mockExec = {
      addTool: vi.fn(),
      getCompletedResults: vi.fn().mockReturnValue([]),
      discard: vi.fn(),
    };

    const stream = asyncFrom([
      makeDeltaChunk({
        tool_calls: [{
          index: 0, id: "tc0", type: "function",
          function: { name: "ReadFile", arguments: '{"path":"a.ts"}' },
        }],
      }),
      makeDeltaChunk({
        tool_calls: [{
          index: 2, id: "tc2", type: "function",
          function: { name: "WriteFile", arguments: '{"path":"b.ts"}' },
        }],
      }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const acc = createAccumulator();
    await collectEvents(consumeStream(stream, acc, mockExec as any, [], new AbortController().signal, 0));

    // Tool at index 0 should have been force-completed when index 2 arrived
    expect(acc.toolCalls.get(0)?.complete).toBe(true);
    expect(mockExec.addTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tc0" }),
      expect.objectContaining({ path: "a.ts" }),
    );
  });

  it("finish_reason before last tool args complete causes flush with partial JSON", async () => {
    const stream = asyncFrom([
      makeDeltaChunk({
        tool_calls: [{
          index: 0, id: "tc0", type: "function",
          function: { name: "Bash", arguments: '{"comman' },
        }],
      }),
      makeDeltaChunk({}, "tool_calls"),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const acc = createAccumulator();
    await collectEvents(consumeStream(stream, acc, null, [], new AbortController().signal, 0));

    expect(acc.finishReason).toBe("tool_calls");
    expect(acc.toolCalls.get(0)?.arguments).toBe('{"comman');
  });

  it("empty string content delta is not accumulated", async () => {
    const stream = asyncFrom([
      makeDeltaChunk({ content: "" }),
      makeDeltaChunk({ content: "real text" }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const acc = createAccumulator();
    const events = await collectEvents(consumeStream(stream, acc, null, [], new AbortController().signal, 0));

    // Empty string is falsy, so it should not be pushed to acc.content
    expect(acc.content).toEqual(["real text"]);
    const textEvents = events.filter(e => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
  });

  it("tool delta with arguments but no id/name on first chunk (deferred start)", async () => {
    const stream = asyncFrom([
      makeDeltaChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"pa' } }],
      }),
      makeDeltaChunk({
        tool_calls: [{ index: 0, id: "tc0", function: { name: "ReadFile", arguments: 'th":"x"}' } }],
      }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const acc = createAccumulator();
    const events = await collectEvents(consumeStream(stream, acc, null, [], new AbortController().signal, 0));

    const tc = acc.toolCalls.get(0)!;
    expect(tc.id).toBe("tc0");
    expect(tc.name).toBe("ReadFile");
    expect(tc.arguments).toBe('{"path":"x"}');

    const startEvents = events.filter(e => e.type === "tool_use_start");
    expect(startEvents).toHaveLength(1);
    expect((startEvents[0] as any).toolName).toBe("ReadFile");
  });

  it("multiple choices in one chunk — last finish_reason wins", async () => {
    const stream = asyncFrom([
      makeChunk({
        choices: [
          { index: 0, delta: { content: "A" }, finish_reason: null },
          { index: 1, delta: { content: "B" }, finish_reason: "stop" },
        ],
      }),
    ]) as unknown as AsyncIterable<ChatStreamChunk>;

    const acc = createAccumulator();
    await collectEvents(consumeStream(stream, acc, null, [], new AbortController().signal, 0));

    expect(acc.finishReason).toBe("stop");
    expect(acc.content).toEqual(["A", "B"]);
  });

  it("idle timeout triggers when stream stalls", async () => {
    async function* stallStream(): AsyncGenerator<ChatStreamChunk> {
      yield makeDeltaChunk({ content: "start" });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const acc = createAccumulator();
    const events: StreamEvent[] = [];
    try {
      for await (const evt of consumeStream(
        stallStream() as AsyncIterable<ChatStreamChunk>,
        acc,
        null,
        [],
        new AbortController().signal,
        50,
      )) {
        events.push(evt);
      }
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/idle timeout/i);
    }

    expect(events).toHaveLength(1);
    expect(acc.content).toEqual(["start"]);
  });
});
