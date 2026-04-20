import { describe, it, expect, beforeEach, vi } from "vitest";
import type { StreamEvent } from "../session/types.js";
import { Thread, type ThreadConfig } from "../thread.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import { CostTracker } from "../cost/tracker.js";
import { calculateCost, findModelPricing, DEFAULT_PRICING } from "../cost/pricing.js";
import type { UsageRecord, ModelPricing } from "../cost/types.js";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textChunk,
  stopChunk,
  toolCallStartChunk,
  toolCallArgChunk,
  toolCallsFinishChunk,
  textResponse,
} from "./helpers.js";
import type { AIProvider, ChatStreamChunk, ChatCompletionUsage, ChatParams } from "../providers/types.js";

function stopWithUsage(usage: ChatCompletionUsage): ChatStreamChunk {
  return {
    id: "mock-usage",
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage,
  };
}

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("Cost pricing", () => {
  it("calculates cost for a known Anthropic model", () => {
    const usage: UsageRecord = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    };
    const cost = calculateCost("claude-sonnet-4", usage);
    // claude-sonnet-4 pricing: $5/1M input, $25/1M output
    expect(cost).toBeCloseTo((1000 / 1e6) * 5 + (500 / 1e6) * 25, 6);
  });

  it("calculates cost for a known OpenAI model", () => {
    const usage: UsageRecord = {
      prompt_tokens: 10000,
      completion_tokens: 2000,
      total_tokens: 12000,
    };
    const cost = calculateCost("gpt-4o", usage);
    // gpt-4o pricing: $2.5/1M input, $10/1M output
    expect(cost).toBeCloseTo((10000 / 1e6) * 2.5 + (2000 / 1e6) * 10, 6);
  });

  it("includes cache tokens in cost calculation without double-counting", () => {
    const usage: UsageRecord = {
      prompt_tokens: 6000,
      completion_tokens: 500,
      total_tokens: 6500,
      cache_read_tokens: 5000,
      cache_creation_tokens: 0,
    };
    const cost = calculateCost("claude-sonnet-4", usage);
    // nonCachedInput = 6000 - 5000 - 0 = 1000
    // $5/1M * 1000 input + $25/1M * 500 output + $0.5/1M * 5000 cache read
    const expected =
      (1000 / 1e6) * 5 +
      (500 / 1e6) * 25 +
      (5000 / 1e6) * 0.5;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("handles cache_creation_tokens in cost calculation", () => {
    const usage: UsageRecord = {
      prompt_tokens: 3000,
      completion_tokens: 500,
      total_tokens: 3500,
      cache_read_tokens: 0,
      cache_creation_tokens: 2000,
    };
    const cost = calculateCost("claude-sonnet-4", usage);
    // nonCachedInput = 3000 - 0 - 2000 = 1000
    const expected =
      (1000 / 1e6) * 5 +
      (500 / 1e6) * 25 +
      (2000 / 1e6) * 6.25;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("returns 0 for unknown model", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const usage: UsageRecord = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    };
    expect(calculateCost("unknown-model-xyz", usage)).toBe(0);
  });

  it("uses custom pricing when provided", () => {
    const custom: Record<string, ModelPricing> = {
      "my-model": { inputTokens: 100, outputTokens: 200 },
    };
    const usage: UsageRecord = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    };
    const cost = calculateCost("my-model", usage, custom);
    expect(cost).toBeCloseTo((1000 / 1e6) * 100 + (500 / 1e6) * 200, 6);
  });

  it("findModelPricing matches longer keys first", () => {
    const p = findModelPricing("gpt-4o-mini", DEFAULT_PRICING);
    // Should match "gpt-4o-mini" (more specific) not "gpt-4o"
    expect(p).toBeDefined();
    expect(p!.inputTokens).toBe(0.15);
  });
});

describe("CostTracker", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  it("accumulates usage across calls", () => {
    tracker.addUsage("gpt-4o", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    });
    tracker.addUsage("gpt-4o", {
      prompt_tokens: 2000,
      completion_tokens: 1000,
      total_tokens: 3000,
    });

    const s = tracker.getSummary();
    expect(s.totalInputTokens).toBe(3000);
    expect(s.totalOutputTokens).toBe(1500);
    expect(s.totalCostUSD).toBeGreaterThan(0);
    expect(s.byModel["gpt-4o"]).toBeDefined();
    expect(s.byModel["gpt-4o"].inputTokens).toBe(3000);
  });

  it("tracks multiple models separately", () => {
    tracker.addUsage("gpt-4o", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    });
    tracker.addUsage("claude-sonnet-4", {
      prompt_tokens: 2000,
      completion_tokens: 1000,
      total_tokens: 3000,
    });

    const s = tracker.getSummary();
    expect(Object.keys(s.byModel)).toHaveLength(2);
    expect(s.byModel["gpt-4o"].inputTokens).toBe(1000);
    expect(s.byModel["claude-sonnet-4"].inputTokens).toBe(2000);
  });

  it("tracks API duration", () => {
    tracker.addUsage(
      "gpt-4o",
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      500,
    );
    tracker.addUsage(
      "gpt-4o",
      { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      300,
    );

    const s = tracker.getSummary();
    expect(s.duration.apiMs).toBe(800);
  });

  it("resets state", () => {
    tracker.addUsage("gpt-4o", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    });
    tracker.reset();

    const s = tracker.getSummary();
    expect(s.totalCostUSD).toBe(0);
    expect(s.totalInputTokens).toBe(0);
    expect(Object.keys(s.byModel)).toHaveLength(0);
  });

  it("accumulates thinking tokens in summary", () => {
    tracker.addUsage("claude-sonnet-4", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      thinking_tokens: 5000,
    });

    const s = tracker.getSummary();
    expect(s.totalThinkingTokens).toBe(5000);
    expect(s.byModel["claude-sonnet-4"].thinkingTokens).toBe(5000);
  });

  it("includes thinking tokens in formatted summary", () => {
    tracker.addUsage("claude-sonnet-4", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      thinking_tokens: 10000,
    });

    const formatted = tracker.formatSummary();
    expect(formatted).toContain("10.0k thinking");
  });

  it("formats summary as readable string", () => {
    tracker.addUsage("gpt-4o", {
      prompt_tokens: 50000,
      completion_tokens: 10000,
      total_tokens: 60000,
    });

    const formatted = tracker.formatSummary();
    expect(formatted).toContain("Total cost:");
    expect(formatted).toContain("gpt-4o:");
    expect(formatted).toContain("50.0k input");
  });
});

describe("Cost tracking in Thread", () => {
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

  it("yields cost_update events when costTracker is configured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracker = new CostTracker();
    provider.addResponse([
      textChunk("hi"),
      stopWithUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      }),
    ]);

    const thread = new Thread(
      { ...baseConfig, costTracker: tracker },
      { sessionId: "cost-1" },
    );

    const events = await collectEvents(thread.run("hello"));
    const costEvents = events.filter((e) => e.type === "cost_update");
    expect(costEvents).toHaveLength(1);

    const costEvent = costEvents[0] as Extract<StreamEvent, { type: "cost_update" }>;
    expect(costEvent.summary.totalInputTokens).toBe(100);
    expect(costEvent.summary.totalOutputTokens).toBe(50);
  });

  it("does not yield cost_update events when no costTracker", async () => {
    provider.addResponse([
      textChunk("hi"),
      stopWithUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      }),
    ]);

    const thread = new Thread(baseConfig, { sessionId: "cost-2" });
    const events = await collectEvents(thread.run("hello"));
    const costEvents = events.filter((e) => e.type === "cost_update");
    expect(costEvents).toHaveLength(0);
  });
});

describe("Cost pricing — thinking token handling", () => {
  it("does not double-count thinking tokens (they are included in completion_tokens)", () => {
    const usageWithThinking: UsageRecord = {
      prompt_tokens: 1000,
      completion_tokens: 10000,
      total_tokens: 11000,
      thinking_tokens: 5000,
    };
    const usageWithout: UsageRecord = {
      prompt_tokens: 1000,
      completion_tokens: 10000,
      total_tokens: 11000,
    };
    const costWith = calculateCost("claude-sonnet-4", usageWithThinking);
    const costWithout = calculateCost("claude-sonnet-4", usageWithout);
    expect(costWith).toBe(costWithout);
  });

  it("charges output cost only once for thinking-heavy responses", () => {
    const usage: UsageRecord = {
      prompt_tokens: 0,
      completion_tokens: 1_000_000,
      total_tokens: 1_000_000,
      thinking_tokens: 900_000,
    };
    const cost = calculateCost("claude-sonnet-4", usage);
    expect(cost).toBeCloseTo((1_000_000 / 1e6) * 25, 6);
  });
});

// ---------------------------------------------------------------------------
// Multi-turn cost tracking integration
// ---------------------------------------------------------------------------
describe("Multi-turn cost tracking", () => {
  it("emits cumulative cost_update events across multiple inner-loop iterations", async () => {
    const fs = new MockFs();
    const computer = new MockComputer();

    let callCount = 0;
    const multiTurnProvider: AIProvider = {
      defaultModel: "mock-model",
      async *chat(_params: ChatParams) {
        callCount++;
        if (callCount === 1) {
          // First call: tool call with usage
          yield toolCallStartChunk("tc_1", "ReadFile");
          yield toolCallArgChunk('{"file_path":"/a.txt"}');
          yield toolCallsFinishChunk({
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          });
        } else if (callCount === 2) {
          // Second call: another tool call with usage
          yield toolCallStartChunk("tc_2", "ReadFile");
          yield toolCallArgChunk('{"file_path":"/b.txt"}');
          yield toolCallsFinishChunk({
            prompt_tokens: 200,
            completion_tokens: 60,
            total_tokens: 260,
          });
        } else {
          // Final text response with usage
          yield textChunk("Done reading both files.");
          yield stopChunk({
            prompt_tokens: 300,
            completion_tokens: 30,
            total_tokens: 330,
          });
        }
      },
    };

    const tracker = new CostTracker();
    const config: ThreadConfig = {
      provider: multiTurnProvider,
      fs,
      computer,
      sessionDir: "/sessions",
      autoCompact: createAutoCompactConfig({ enabled: false }),
      costTracker: tracker,
      tools: [
        {
          name: "ReadFile",
          description: "Read a file",
          parameters: { type: "object", properties: { file_path: { type: "string" } } },
          isReadOnly: true,
          async call(args: Record<string, unknown>) {
            return { content: `content of ${args.file_path}` };
          },
        },
      ],
    };

    const thread = new Thread(config, { sessionId: "multi-cost" });
    const events = await collectEvents(thread.run("read files"));

    const costEvents = events.filter((e) => e.type === "cost_update");
    // Should have 3 cost_update events (one per provider call)
    expect(costEvents).toHaveLength(3);

    // Each successive cost_update should have cumulative totals
    const summaries = costEvents.map((e) => (e as any).summary);
    expect(summaries[0].totalInputTokens).toBe(100);
    expect(summaries[1].totalInputTokens).toBe(300); // 100 + 200
    expect(summaries[2].totalInputTokens).toBe(600); // 300 + 300

    expect(summaries[0].totalOutputTokens).toBe(50);
    expect(summaries[1].totalOutputTokens).toBe(110); // 50 + 60
    expect(summaries[2].totalOutputTokens).toBe(140); // 110 + 30

    // Verify the tracker state is cumulative
    const final = tracker.getSummary();
    expect(final.totalInputTokens).toBe(600);
    expect(final.totalOutputTokens).toBe(140);

    // Verify costState is persisted in JSONL
    const jsonl = fs.files.get("/sessions/multi-cost.jsonl")!;
    const lines = jsonl.trim().split("\n").map((l: string) => JSON.parse(l));
    const metadataEntries = lines.filter(
      (e: any) => e.type === "metadata" && e.key === "costState",
    );
    expect(metadataEntries.length).toBeGreaterThanOrEqual(1);
  });
});
