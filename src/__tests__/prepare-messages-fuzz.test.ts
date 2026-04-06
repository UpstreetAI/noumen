import { describe, it, expect } from "vitest";
import type {
  ChatMessage,
  AssistantMessage,
  ToolResultMessage,
  ToolCallContent,
} from "../session/types.js";
import { prepareMessagesForApi, type PrepareMessagesState } from "../pipeline/prepare-messages.js";
import { createBudgetState } from "../compact/tool-result-budget.js";
import { createContentReplacementState } from "../compact/tool-result-storage.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";
import { assertValidMessageSequence } from "../messages/invariants.js";
import { COMPACTABLE_TOOLS, CLEARED_PLACEHOLDER } from "../compact/microcompact.js";
import { SeededRng } from "./helpers.js";

const TOOL_NAMES = [...COMPACTABLE_TOOLS, "CustomTool", "MathTool"];

let _idCounter = 0;
function freshId(): string {
  return `tc_${++_idCounter}`;
}

function makeTc(id: string, name: string): ToolCallContent {
  return {
    id,
    type: "function",
    function: { name, arguments: '{"path":"test.ts"}' },
  };
}

function generateFuzzMessages(rng: SeededRng): ChatMessage[] {
  const len = rng.int(2, 15);
  const messages: ChatMessage[] = [];
  const emittedToolUseIds: string[] = [];

  messages.push({ role: "user", content: `start ${rng.int(0, 100)}` });

  for (let i = 1; i < len; i++) {
    const roll = rng.next();

    if (roll < 0.15) {
      messages.push({ role: "user", content: `user msg ${i}` });
    } else if (roll < 0.50) {
      const numCalls = rng.int(1, 3);
      const calls: ToolCallContent[] = [];
      for (let j = 0; j < numCalls; j++) {
        const id = freshId();
        const toolName = rng.pick(TOOL_NAMES);
        calls.push(makeTc(id, toolName));
        emittedToolUseIds.push(id);
      }
      messages.push({
        role: "assistant",
        content: rng.bool(0.4) ? `text ${i}` : null,
        tool_calls: calls,
      } as AssistantMessage);
    } else if (roll < 0.80 && emittedToolUseIds.length > 0) {
      const callId = rng.pick(emittedToolUseIds);
      const contentSize = rng.bool(0.3) ? rng.int(30_000, 80_000) : rng.int(10, 500);
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: "x".repeat(contentSize),
      } as ToolResultMessage);
    } else {
      messages.push({
        role: "assistant",
        content: `reply ${i}`,
      } as AssistantMessage);
    }
  }

  return messages;
}

function initialState(): PrepareMessagesState {
  return {
    contentReplacementState: createContentReplacementState(),
    budgetState: createBudgetState(),
    microcompactTokensFreed: 0,
  };
}

function assertApiValidity(msgs: ChatMessage[], label: string): void {
  try {
    assertValidMessageSequence(msgs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    expect.fail(`${label} API validity: ${msg}`);
  }
}

function assertIdempotency(msgs: ChatMessage[], label: string): void {
  const second = normalizeMessagesForAPI(msgs);
  expect(second, `${label} idempotency`).toEqual(msgs);
}

function assertBudgetLimits(
  msgs: ChatMessage[],
  maxCharsPerResult: number,
  label: string,
): void {
  for (const msg of msgs) {
    if (msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (content === CLEARED_PLACEHOLDER) continue;
    if (content.includes("[truncated,")) continue;
    expect(
      content.length,
      `${label}: tool result exceeds budget (${content.length} > ${maxCharsPerResult})`,
    ).toBeLessThanOrEqual(maxCharsPerResult + 200);
  }
}

// ---------------------------------------------------------------------------
// prepareMessagesForApi — fuzz
// ---------------------------------------------------------------------------

const SEEDS = [42, 137, 2025, 9999, 31337, 65536, 777, 12345, 99999, 314159];
const ITERATIONS_PER_SEED = 200;

describe("prepareMessagesForApi — fuzz", () => {
  for (const seed of SEEDS) {
    it(`invariants hold for seed ${seed}`, async () => {
      _idCounter = 0;
      const rng = new SeededRng(seed);

      for (let iter = 0; iter < ITERATIONS_PER_SEED; iter++) {
        const messages = generateFuzzMessages(rng);
        const label = `seed=${seed} iter=${iter}`;

        const mcEnabled = rng.bool(0.5);
        const budgetEnabled = rng.bool(0.5);
        const maxCharsPerResult = rng.int(5_000, 60_000);

        const state = initialState();
        const baseTokensFreed = rng.int(0, 500);
        state.microcompactTokensFreed = baseTokensFreed;

        const result = await prepareMessagesForApi(messages, {
          sessionId: `fuzz-${seed}-${iter}`,
          microcompact: mcEnabled ? { enabled: true, keepRecent: rng.int(2, 6) } : undefined,
          toolResultBudget: budgetEnabled
            ? { enabled: true, maxCharsPerResult, previewChars: rng.int(100, 1_000) }
            : undefined,
        }, state);

        // Invariant 1: API validity
        assertApiValidity(result.messagesForApi, label);

        // Invariant 2: Idempotency (normalize again should be no-op)
        assertIdempotency(result.messagesForApi, label);

        // Invariant 3: Microcompact monotonicity
        expect(
          result.state.microcompactTokensFreed,
          `${label}: microcompact tokens freed decreased`,
        ).toBeGreaterThanOrEqual(baseTokensFreed);

        // Invariant 4: Budget respects limits
        if (budgetEnabled) {
          assertBudgetLimits(result.messagesForApi, maxCharsPerResult, label);
        }

        // Invariant 5: Input state not mutated
        expect(state.microcompactTokensFreed, `${label}: input state mutated`).toBe(baseTokensFreed);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Determinism: same inputs → same outputs (when disk spill is off)
// ---------------------------------------------------------------------------

describe("prepareMessagesForApi — determinism", () => {
  for (const seed of SEEDS.slice(0, 5)) {
    it(`deterministic for seed ${seed}`, async () => {
      for (let iter = 0; iter < 50; iter++) {
        _idCounter = 0;
        const rng1 = new SeededRng(seed + iter);
        const messages1 = generateFuzzMessages(rng1);

        _idCounter = 0;
        const rng2 = new SeededRng(seed + iter);
        const messages2 = generateFuzzMessages(rng2);

        const config = {
          sessionId: `det-${seed}-${iter}`,
          microcompact: { enabled: true, keepRecent: 3 } as const,
          toolResultBudget: { enabled: true, maxCharsPerResult: 20_000, previewChars: 500 } as const,
        };

        const result1 = await prepareMessagesForApi(messages1, config, initialState());
        const result2 = await prepareMessagesForApi(messages2, config, initialState());

        expect(result1.messagesForApi, `seed=${seed} iter=${iter}: not deterministic`).toEqual(
          result2.messagesForApi,
        );
        expect(result1.state, `seed=${seed} iter=${iter}: state not deterministic`).toEqual(
          result2.state,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("prepareMessagesForApi — fuzz edge cases", () => {
  it("empty messages array produces valid output", async () => {
    const result = await prepareMessagesForApi([], {
      sessionId: "edge-empty",
    }, initialState());

    assertApiValidity(result.messagesForApi, "empty");
    expect(result.events).toEqual([]);
  });

  it("single user message passthrough", async () => {
    const result = await prepareMessagesForApi(
      [{ role: "user", content: "hello" }],
      { sessionId: "edge-single" },
      initialState(),
    );

    assertApiValidity(result.messagesForApi, "single-user");
    expect(result.canonicalMessages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("all stages enabled with no eligible content is a no-op", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "ok" },
    ];

    const result = await prepareMessagesForApi(messages, {
      sessionId: "edge-noop",
      microcompact: { enabled: true, keepRecent: 5 },
      toolResultBudget: { enabled: true, maxCharsPerResult: 50_000 },
    }, initialState());

    assertApiValidity(result.messagesForApi, "all-enabled-no-content");
    expect(result.state.microcompactTokensFreed).toBe(0);
    expect(result.events).toEqual([]);
  });
});
