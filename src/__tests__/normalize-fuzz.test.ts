import { describe, it, expect } from "vitest";
import type {
  ChatMessage,
  AssistantMessage,
  ToolResultMessage,
  ToolCallContent,
  ContentPart,
} from "../session/types.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";
import { adjustSplitForToolPairs } from "../compact/compact.js";
import { assertValidMessageSequence } from "../messages/invariants.js";
import { sanitizeForResume } from "../session/recovery.js";
import { SeededRng } from "./helpers.js";

// ---------------------------------------------------------------------------
// Message generator — produces realistic corrupted ChatMessage arrays
// ---------------------------------------------------------------------------

const TOOL_NAMES = ["Bash", "ReadFile", "WriteFile", "Glob", "Grep"];

let _idCounter = 0;
function freshId(): string {
  return `tc_${++_idCounter}`;
}

function makeTc(id: string, name?: string): ToolCallContent {
  return {
    id,
    type: "function",
    function: {
      name: name ?? "Bash",
      arguments: '{"command":"ls"}',
    },
  };
}

/**
 * Generate a random ChatMessage array with a mix of valid structure and
 * realistic corruption patterns. Uses a SeededRng so every call with the
 * same RNG state produces the same output.
 */
let _turnCounter = 0;

function generateRandomMessages(rng: SeededRng): ChatMessage[] {
  const len = rng.int(1, 20);
  const messages: ChatMessage[] = [];

  const emittedToolUseIds: string[] = [];
  const emittedToolResultIds: string[] = [];

  for (let i = 0; i < len; i++) {
    const roll = rng.next();

    if (roll < 0.05) {
      messages.push({ role: "system", content: `System prompt ${i}` });
    } else if (roll < 0.25) {
      if (rng.bool(0.2)) {
        const parts: ContentPart[] = [{ type: "text", text: `user part ${i}` }];
        if (rng.bool(0.3)) {
          parts.push({ type: "text", text: `extra part ${i}` });
        }
        messages.push({ role: "user", content: parts });
      } else {
        messages.push({ role: "user", content: `user msg ${i}` });
      }
    } else if (roll < 0.55) {
      const flavor = rng.next();

      if (flavor < 0.12) {
        const ws = rng.pick(["", "  ", " \n ", "\t"]);
        messages.push({ role: "assistant", content: ws } as AssistantMessage);
      } else if (flavor < 0.22) {
        messages.push({
          role: "assistant",
          content: null,
          ...(rng.bool(0.5) ? { thinking_content: `thinking ${i}` } : {}),
          ...(rng.bool(0.3) ? { thinking_signature: `sig_${i}` } : {}),
        } as AssistantMessage);
      } else if (flavor < 0.30) {
        messages.push({
          role: "assistant",
          content: `empty tc ${i}`,
          tool_calls: [],
        } as unknown as AssistantMessage);
      } else if (flavor < 0.52) {
        const numCalls = rng.int(1, 3);
        const calls: ToolCallContent[] = [];
        for (let j = 0; j < numCalls; j++) {
          let id: string;
          if (emittedToolUseIds.length > 0 && rng.bool(0.2)) {
            id = rng.pick(emittedToolUseIds);
          } else {
            id = freshId();
          }
          calls.push(makeTc(id, rng.pick(TOOL_NAMES)));
          emittedToolUseIds.push(id);
        }
        messages.push({
          role: "assistant",
          content: rng.bool(0.4) ? `text ${i}` : null,
          tool_calls: calls,
          ...(rng.bool(0.2) ? { thinking_content: `think ${i}` } : {}),
          ...(rng.bool(0.1) ? { thinking_signature: `sig_${i}` } : {}),
          ...(rng.bool(0.1) ? { redacted_thinking_data: `redacted_${i}` } : {}),
          ...(rng.bool(0.15) ? { _turnId: `turn_${_turnCounter++}` } : {}),
        } as AssistantMessage);
      } else if (flavor < 0.60) {
        // Assistant with _turnId matching a previous assistant (non-adjacent merge)
        const prevTurnAsst = messages.filter(
          (m) => m.role === "assistant" && (m as AssistantMessage)._turnId,
        );
        const matchTurnId = prevTurnAsst.length > 0 && rng.bool(0.5)
          ? (rng.pick(prevTurnAsst) as AssistantMessage)._turnId
          : `turn_${_turnCounter++}`;
        messages.push({
          role: "assistant",
          content: rng.bool(0.5) ? `split ${i}` : null,
          ...(rng.bool(0.3) ? { tool_calls: [makeTc(freshId(), rng.pick(TOOL_NAMES))] } : {}),
          ...(rng.bool(0.2) ? { thinking_content: `split_think ${i}` } : {}),
          _turnId: matchTurnId,
        } as AssistantMessage);
      } else {
        messages.push({
          role: "assistant",
          content: `reply ${i}`,
          ...(rng.bool(0.15) ? { thinking_content: `thought ${i}` } : {}),
          ...(rng.bool(0.1) ? { thinking_signature: `sig_${i}` } : {}),
        } as AssistantMessage);
      }
    } else if (roll < 0.80) {
      let callId: string;
      if (emittedToolUseIds.length > 0 && rng.bool(0.6)) {
        callId = rng.pick(emittedToolUseIds);
        if (emittedToolResultIds.includes(callId) && rng.bool(0.5)) {
          // duplicate — keep going
        }
      } else {
        callId = rng.bool(0.3) ? `orphan_${i}` : freshId();
      }
      emittedToolResultIds.push(callId);
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: rng.bool(0.2) ? `Error: something failed` : `result ${i}`,
        ...(rng.bool(0.15) ? { isError: true } : {}),
      } as ToolResultMessage);
    } else if (roll < 0.84) {
      // User message with images (for image validation fuzz)
      const numImages = rng.int(1, 8);
      const parts: ContentPart[] = [{ type: "text", text: `image msg ${i}` }];
      for (let j = 0; j < numImages; j++) {
        const oversized = rng.bool(0.1);
        const invalidFormat = rng.bool(0.1);
        parts.push({
          type: "image",
          data: oversized ? "x".repeat(6 * 1024 * 1024) : `base64data_${i}_${j}`,
          media_type: invalidFormat
            ? rng.pick(["image/bmp", "image/tiff", "application/pdf"])
            : rng.pick(["image/png", "image/jpeg", "image/gif", "image/webp"]),
        } as ContentPart);
      }
      messages.push({ role: "user", content: parts });
    } else if (roll < 0.87) {
      // Displaced tool result: insert a user message between assistant and its tool results
      const lastAsst = [...messages].reverse().find(
        (m) => m.role === "assistant" && (m as AssistantMessage).tool_calls?.length,
      );
      if (lastAsst) {
        messages.push({ role: "user", content: `wedge ${i}` });
        const tc = (lastAsst as AssistantMessage).tool_calls![0];
        if (!emittedToolResultIds.includes(tc.id)) {
          emittedToolResultIds.push(tc.id);
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `displaced result ${i}`,
          } as ToolResultMessage);
        }
      } else {
        messages.push({ role: "user", content: `filler ${i}` });
      }
    } else if (roll < 0.90) {
      const prev = messages[messages.length - 1];
      if (prev) {
        if (prev.role === "user") {
          messages.push({ role: "user", content: `dup user ${i}` });
        } else if (prev.role === "assistant") {
          messages.push({
            role: "assistant",
            content: `dup asst ${i}`,
          } as AssistantMessage);
        } else {
          messages.push({ role: "user", content: `filler ${i}` });
        }
      } else {
        messages.push({ role: "user", content: `first ${i}` });
      }
    } else {
      messages.push({
        role: "assistant",
        content: rng.pick([null, "", "  "]),
        thinking_content: `trailing think ${i}`,
        ...(rng.bool(0.5) ? { thinking_signature: `tsig_${i}` } : {}),
        ...(rng.bool(0.3) ? { redacted_thinking_data: `redact_${i}` } : {}),
      } as AssistantMessage);
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Invariant assertions
// ---------------------------------------------------------------------------

/**
 * Wraps the shared `assertValidMessageSequence` with vitest assertions
 * and adds the idempotency check specific to fuzz testing.
 */
const MAX_IMAGES_PER_REQUEST = 20;

function assertNormalizationInvariants(
  result: ChatMessage[],
  label: string,
): void {
  try {
    assertValidMessageSequence(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    expect.fail(`${label}: ${msg}`);
  }

  // Idempotency: normalizing again should produce identical output
  const second = normalizeMessagesForAPI(result);
  expect(second, `${label}: not idempotent`).toEqual(result);

  // No _turnId on output messages
  for (const msg of result) {
    if (msg.role === "assistant") {
      expect(
        (msg as AssistantMessage)._turnId,
        `${label}: _turnId not stripped`,
      ).toBeUndefined();
    }
  }

  // No _meta in tool args
  for (const msg of result) {
    if (msg.role === "assistant" && (msg as AssistantMessage).tool_calls) {
      for (const tc of (msg as AssistantMessage).tool_calls!) {
        try {
          const args = JSON.parse(tc.function.arguments);
          expect(args._meta, `${label}: _meta not stripped from tool args`).toBeUndefined();
        } catch {
          // Malformed JSON — not our concern here
        }
      }
    }
  }

  // Image count per user message <= cap
  let totalImages = 0;
  for (const msg of result) {
    if (msg.role === "assistant") continue;
    const content = (msg as { content: string | ContentPart[] }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if ((part as ContentPart).type === "image") totalImages++;
    }
  }
  expect(
    totalImages,
    `${label}: too many images (${totalImages} > ${MAX_IMAGES_PER_REQUEST})`,
  ).toBeLessThanOrEqual(MAX_IMAGES_PER_REQUEST);
}

// ---------------------------------------------------------------------------
// normalizeMessagesForAPI — fuzz
// ---------------------------------------------------------------------------

const SEEDS = [42, 137, 2025, 9999, 31337, 65536, 777, 12345, 99999, 314159];
const ITERATIONS_PER_SEED = 500;

describe("normalizeMessagesForAPI — fuzz", () => {
  for (const seed of SEEDS) {
    it(`invariants hold for seed ${seed}`, () => {
      _idCounter = 0;
      const rng = new SeededRng(seed);

      for (let iter = 0; iter < ITERATIONS_PER_SEED; iter++) {
        const messages = generateRandomMessages(rng);
        const result = normalizeMessagesForAPI(messages);
        assertNormalizationInvariants(result, `seed=${seed} iter=${iter}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// sanitizeForResume — fuzz
// ---------------------------------------------------------------------------

describe("sanitizeForResume — fuzz", () => {
  for (const seed of SEEDS) {
    it(`produces valid output for seed ${seed}`, () => {
      _idCounter = 0;
      const rng = new SeededRng(seed);

      for (let iter = 0; iter < ITERATIONS_PER_SEED; iter++) {
        const messages = generateRandomMessages(rng);
        const { messages: sanitized, interruption, removals } =
          sanitizeForResume(messages);

        // Interruption is a valid kind
        expect(
          ["none", "interrupted_tool", "interrupted_prompt"],
          `seed=${seed} iter=${iter}: invalid interruption kind "${interruption.kind}"`,
        ).toContain(interruption.kind);

        // Removal counts are non-negative
        expect(
          removals.unresolvedToolUses,
          `seed=${seed} iter=${iter}: negative unresolvedToolUses`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          removals.whitespaceOnly,
          `seed=${seed} iter=${iter}: negative whitespaceOnly`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          removals.orphanedThinking,
          `seed=${seed} iter=${iter}: negative orphanedThinking`,
        ).toBeGreaterThanOrEqual(0);

        // After normalizing the sanitized output, invariants still hold
        const normalized = normalizeMessagesForAPI(sanitized);
        assertNormalizationInvariants(
          normalized,
          `seed=${seed} iter=${iter} (sanitize+normalize)`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Degenerate edge cases
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI — fuzz edge cases", () => {
  it("handles empty array", () => {
    const result = normalizeMessagesForAPI([]);
    assertNormalizationInvariants(result, "empty");
  });

  it("handles single system message", () => {
    const result = normalizeMessagesForAPI([
      { role: "system", content: "instructions" },
    ]);
    assertNormalizationInvariants(result, "single-system");
  });

  it("handles all-tool-result array", () => {
    const result = normalizeMessagesForAPI([
      { role: "tool", tool_call_id: "t1", content: "ok" } as ToolResultMessage,
      { role: "tool", tool_call_id: "t2", content: "ok" } as ToolResultMessage,
      { role: "tool", tool_call_id: "t3", content: "ok" } as ToolResultMessage,
    ]);
    assertNormalizationInvariants(result, "all-tool-result");
  });

  it("handles all-assistant array with no user", () => {
    const result = normalizeMessagesForAPI([
      { role: "assistant", content: "a" } as AssistantMessage,
      { role: "assistant", content: "b" } as AssistantMessage,
      { role: "assistant", content: "c" } as AssistantMessage,
    ]);
    assertNormalizationInvariants(result, "all-assistant");
  });

  it("handles all-null-content assistants", () => {
    const result = normalizeMessagesForAPI([
      { role: "assistant", content: null } as AssistantMessage,
      { role: "assistant", content: null } as AssistantMessage,
    ]);
    assertNormalizationInvariants(result, "all-null-assistant");
  });

  it("handles 100-message deeply corrupted array", () => {
    _idCounter = 0;
    const rng = new SeededRng(42424242);
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(...generateRandomMessages(rng));
    }
    // Force at least 100 messages
    while (messages.length < 100) {
      messages.push(...generateRandomMessages(rng));
    }
    const result = normalizeMessagesForAPI(messages);
    assertNormalizationInvariants(result, "100-msg-corrupted");
  });

  it("handles tool_result before any assistant", () => {
    const result = normalizeMessagesForAPI([
      { role: "tool", tool_call_id: "t1", content: "orphan" } as ToolResultMessage,
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" } as AssistantMessage,
    ]);
    assertNormalizationInvariants(result, "tool-result-first");
  });

  it("handles interleaved system messages breaking role alternation", () => {
    const result = normalizeMessagesForAPI([
      { role: "user", content: "a" },
      { role: "system", content: "injected" },
      { role: "user", content: "b" },
      { role: "assistant", content: "reply" } as AssistantMessage,
    ]);
    assertNormalizationInvariants(result, "system-breaks-alternation");
  });

  it("handles assistant with only redacted_thinking_data at end", () => {
    const result = normalizeMessagesForAPI([
      { role: "user", content: "think" },
      {
        role: "assistant",
        content: null,
        thinking_content: "secret",
        redacted_thinking_data: "REDACTED",
      } as AssistantMessage,
    ]);
    assertNormalizationInvariants(result, "trailing-redacted-thinking");
  });

  it("handles messages with _turnId fields", () => {
    const tcId = freshId();
    const result = normalizeMessagesForAPI([
      { role: "user", content: "go" },
      { role: "assistant", content: "part 1", tool_calls: [makeTc(tcId)], _turnId: "t1" } as AssistantMessage,
      { role: "tool", tool_call_id: tcId, content: "ok" } as ToolResultMessage,
    ]);
    assertNormalizationInvariants(result, "turnid-messages");
  });
});

// ---------------------------------------------------------------------------
// Compaction split fuzz — adjustSplitForToolPairs never orphans pairs
// ---------------------------------------------------------------------------

describe("adjustSplitForToolPairs — fuzz", () => {
  const SPLIT_SEEDS = [42, 137, 2025, 9999, 31337];

  for (const seed of SPLIT_SEEDS) {
    it(`split never orphans tool pairs for seed ${seed}`, () => {
      _idCounter = 0;
      _turnCounter = 0;
      const rng = new SeededRng(seed);

      for (let iter = 0; iter < 100; iter++) {
        const raw = generateRandomMessages(rng);
        const messages = normalizeMessagesForAPI(raw);
        if (messages.length < 3) continue;

        const splitIdx = rng.int(1, messages.length - 1);
        const adjusted = adjustSplitForToolPairs(messages, splitIdx);

        expect(adjusted).toBeGreaterThanOrEqual(0);
        expect(adjusted).toBeLessThanOrEqual(messages.length);

        // If the adjusted split lands on a tool result, the preceding
        // assistant must be in the same partition (tail).
        if (adjusted < messages.length && messages[adjusted]?.role === "tool") {
          let foundAsst = false;
          for (let k = adjusted - 1; k >= 0; k--) {
            if (messages[k].role === "assistant") {
              const asst = messages[k] as AssistantMessage;
              if (asst.tool_calls && asst.tool_calls.length > 0) {
                foundAsst = true;
              }
              break;
            }
          }
          if (foundAsst) {
            expect(adjusted).toBeLessThanOrEqual(splitIdx);
          }
        }

        // Both partitions should independently normalize to valid sequences
        const head = messages.slice(0, adjusted);
        const tail = messages.slice(adjusted);

        if (head.length > 0) {
          const normalizedHead = normalizeMessagesForAPI(head);
          try {
            assertValidMessageSequence(normalizedHead);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            expect.fail(
              `seed=${seed} iter=${iter} head partition: ${msg}`,
            );
          }
        }
        if (tail.length > 0) {
          const normalizedTail = normalizeMessagesForAPI(tail);
          try {
            assertValidMessageSequence(normalizedTail);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            expect.fail(
              `seed=${seed} iter=${iter} tail partition: ${msg}`,
            );
          }
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Composition fuzz — normalize, grow, normalize again
// ---------------------------------------------------------------------------

describe("normalizeMessagesForAPI — composition fuzz", () => {
  const COMP_SEEDS = [42, 137, 2025, 9999, 31337];

  for (const seed of COMP_SEEDS) {
    it(`invariants hold after incremental growth for seed ${seed}`, () => {
      _idCounter = 0;
      _turnCounter = 0;
      const rng = new SeededRng(seed);

      for (let iter = 0; iter < 100; iter++) {
        // Start with a normalized base
        const raw = generateRandomMessages(rng);
        let messages = normalizeMessagesForAPI(raw);

        // Append a new valid turn (user -> assistant -> tool -> assistant)
        const newTcId = freshId();
        messages = [
          ...messages,
          { role: "user", content: `grow ${iter}` },
          {
            role: "assistant",
            content: null,
            tool_calls: [makeTc(newTcId, rng.pick(TOOL_NAMES))],
          } as AssistantMessage,
          { role: "tool", tool_call_id: newTcId, content: `result ${iter}` } as ToolResultMessage,
          { role: "assistant", content: `done ${iter}` } as AssistantMessage,
        ];

        // Re-normalize and check
        const result = normalizeMessagesForAPI(messages);
        assertNormalizationInvariants(result, `seed=${seed} comp=${iter}`);
      }
    });
  }
});
