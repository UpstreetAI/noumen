import { describe, it, expect } from "vitest";
import type {
  ChatMessage,
  AssistantMessage,
  ToolResultMessage,
  ToolCallContent,
  ContentPart,
} from "../session/types.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";
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
function generateRandomMessages(rng: SeededRng): ChatMessage[] {
  const len = rng.int(1, 20);
  const messages: ChatMessage[] = [];

  // Pool of tool_call IDs that have been "used" by assistants — allows
  // the generator to create orphans, duplicates, and missing results.
  const emittedToolUseIds: string[] = [];
  const emittedToolResultIds: string[] = [];

  for (let i = 0; i < len; i++) {
    const roll = rng.next();

    if (roll < 0.05) {
      // ~5%: system message
      messages.push({ role: "system", content: `System prompt ${i}` });
    } else if (roll < 0.25) {
      // ~20%: user message
      if (rng.bool(0.2)) {
        // ContentPart[] variant
        const parts: ContentPart[] = [{ type: "text", text: `user part ${i}` }];
        if (rng.bool(0.3)) {
          parts.push({ type: "text", text: `extra part ${i}` });
        }
        messages.push({ role: "user", content: parts });
      } else {
        messages.push({ role: "user", content: `user msg ${i}` });
      }
    } else if (roll < 0.55) {
      // ~30%: assistant message (various flavors)
      const flavor = rng.next();

      if (flavor < 0.15) {
        // Whitespace-only assistant (no tool_calls)
        const ws = rng.pick(["", "  ", " \n ", "\t"]);
        messages.push({ role: "assistant", content: ws } as AssistantMessage);
      } else if (flavor < 0.25) {
        // Null-content assistant (thinking artifact)
        messages.push({
          role: "assistant",
          content: null,
          ...(rng.bool(0.5)
            ? { thinking_content: `thinking ${i}` }
            : {}),
          ...(rng.bool(0.3)
            ? { thinking_signature: `sig_${i}` }
            : {}),
        } as AssistantMessage);
      } else if (flavor < 0.35) {
        // Assistant with empty tool_calls array
        messages.push({
          role: "assistant",
          content: `empty tc ${i}`,
          tool_calls: [],
        } as unknown as AssistantMessage);
      } else if (flavor < 0.55) {
        // Assistant with tool_calls (some may be duplicates)
        const numCalls = rng.int(1, 3);
        const calls: ToolCallContent[] = [];
        for (let j = 0; j < numCalls; j++) {
          let id: string;
          if (emittedToolUseIds.length > 0 && rng.bool(0.2)) {
            // Reuse an existing ID (duplicate)
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
        } as AssistantMessage);
      } else {
        // Normal text assistant
        messages.push({
          role: "assistant",
          content: `reply ${i}`,
          ...(rng.bool(0.15) ? { thinking_content: `thought ${i}` } : {}),
          ...(rng.bool(0.1) ? { thinking_signature: `sig_${i}` } : {}),
        } as AssistantMessage);
      }
    } else if (roll < 0.80) {
      // ~25%: tool result message
      let callId: string;
      if (emittedToolUseIds.length > 0 && rng.bool(0.6)) {
        callId = rng.pick(emittedToolUseIds);
        // Possibly create a duplicate result
        if (emittedToolResultIds.includes(callId) && rng.bool(0.5)) {
          // duplicate — keep going
        }
      } else {
        // Orphan: reference an ID that may not exist
        callId = rng.bool(0.3) ? `orphan_${i}` : freshId();
      }
      emittedToolResultIds.push(callId);
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: rng.bool(0.2) ? `Error: something failed` : `result ${i}`,
        ...(rng.bool(0.15) ? { isError: true } : {}),
      } as ToolResultMessage);
    } else if (roll < 0.90) {
      // ~10%: consecutive same-role (force a duplicate of the previous role)
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
      // ~10%: thinking-only trailing assistant candidate
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

function assertNormalizationInvariants(
  result: ChatMessage[],
  label: string,
): void {
  // 1. Non-empty
  expect(result.length, `${label}: should be non-empty`).toBeGreaterThanOrEqual(1);

  // 2. Starts with user
  expect(result[0].role, `${label}: should start with user`).toBe("user");

  // 3. No system messages
  for (let i = 0; i < result.length; i++) {
    expect(
      result[i].role,
      `${label}: message[${i}] should not be system`,
    ).not.toBe("system");
  }

  // 4. No consecutive same non-tool role
  for (let i = 1; i < result.length; i++) {
    const prev = result[i - 1].role;
    const curr = result[i].role;
    if (curr !== "tool" && prev !== "tool") {
      expect(
        curr,
        `${label}: messages[${i - 1}](${prev}) and [${i}](${curr}) are consecutive same role`,
      ).not.toBe(prev);
    }
  }

  // Collect tool_use and tool_result IDs for pairing checks
  const toolUseIds: string[] = [];
  const toolUseIdSet = new Set<string>();
  const toolResultIds: string[] = [];
  const toolResultIdSet = new Set<string>();

  for (const msg of result) {
    if (msg.role === "assistant") {
      const asst = msg as AssistantMessage;
      if (asst.tool_calls) {
        for (const tc of asst.tool_calls) {
          toolUseIds.push(tc.id);
          toolUseIdSet.add(tc.id);
        }
      }
    } else if (msg.role === "tool") {
      const tr = msg as ToolResultMessage;
      toolResultIds.push(tr.tool_call_id);
      toolResultIdSet.add(tr.tool_call_id);
    }
  }

  // 5. No duplicate tool_use IDs
  expect(
    toolUseIds.length,
    `${label}: duplicate tool_use IDs found`,
  ).toBe(toolUseIdSet.size);

  // 6. No duplicate tool_result IDs
  expect(
    toolResultIds.length,
    `${label}: duplicate tool_result IDs found`,
  ).toBe(toolResultIdSet.size);

  // 7. Every tool_use has a matching tool_result
  for (const id of toolUseIdSet) {
    expect(
      toolResultIdSet.has(id),
      `${label}: tool_use "${id}" has no matching tool_result`,
    ).toBe(true);
  }

  // 8. Every tool_result has a matching tool_use
  for (const id of toolResultIdSet) {
    expect(
      toolUseIdSet.has(id),
      `${label}: tool_result "${id}" has no matching tool_use`,
    ).toBe(true);
  }

  // 9. No whitespace-only assistants without tool_calls
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== "assistant") continue;
    const asst = msg as AssistantMessage;
    if (asst.tool_calls && asst.tool_calls.length > 0) continue;
    const text =
      typeof asst.content === "string" ? asst.content : "";
    if (text.trim() === "" && !asst.thinking_content) {
      // Allowed only if content is explicitly "" (ensureNonEmptyAssistantContent
      // sets this). But there must be tool_calls or real content to survive
      // all filters — so if we get here it means filters didn't remove it.
      // The only exception: thinking-only assistants are allowed mid-conversation
      // (only trailing ones are stripped).
      expect(
        asst.content !== null && asst.content !== undefined,
        `${label}: message[${i}] is whitespace-only assistant with null content and no tool_calls`,
      ).toBe(true);
    }
  }

  // 10. No null/undefined assistant content (ensureNonEmptyAssistantContent)
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== "assistant") continue;
    const asst = msg as AssistantMessage;
    expect(
      asst.content !== null && asst.content !== undefined,
      `${label}: message[${i}] assistant has null/undefined content`,
    ).toBe(true);
  }

  // 11. Idempotent
  const second = normalizeMessagesForAPI(result);
  expect(second, `${label}: not idempotent`).toEqual(result);
}

// ---------------------------------------------------------------------------
// normalizeMessagesForAPI — fuzz
// ---------------------------------------------------------------------------

const SEEDS = [42, 137, 2025, 9999, 31337, 65536, 777, 12345, 99999, 314159];
const ITERATIONS_PER_SEED = 200;

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
});
