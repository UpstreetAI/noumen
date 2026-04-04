import { describe, it, expect } from "vitest";
import {
  createAutoCompactConfig,
  shouldAutoCompact,
  createAutoCompactTracking,
  canAutoCompact,
  recordAutoCompactSuccess,
  recordAutoCompactFailure,
} from "../compact/auto-compact.js";
import type { ChatMessage } from "../session/types.js";

describe("enhanced auto-compact", () => {
  describe("createAutoCompactConfig with model", () => {
    it("uses model-derived threshold when model is provided", () => {
      const config = createAutoCompactConfig({ model: "claude-sonnet-4-20250514" });
      // claude-sonnet-4-20250514 → 200k window, effective = 200k - 20k = 180k, threshold = 180k - 13k = 167k
      expect(config.threshold).toBe(167_000);
    });

    it("uses explicit threshold over model-derived", () => {
      const config = createAutoCompactConfig({ model: "claude-sonnet-4-20250514", threshold: 50_000 });
      expect(config.threshold).toBe(50_000);
    });

    it("falls back to default 100k when no model", () => {
      const config = createAutoCompactConfig();
      expect(config.threshold).toBe(100_000);
    });
  });

  describe("shouldAutoCompact with tokensFreed", () => {
    it("subtracts tokensFreed from the token count", () => {
      const config = createAutoCompactConfig({ threshold: 100 });
      // "x".repeat(500) ≈ 125 tokens + overhead
      const messages: ChatMessage[] = [
        { role: "user", content: "x".repeat(500) },
      ];

      // Without tokensFreed, should compact
      expect(shouldAutoCompact(messages, config)).toBe(true);

      // With enough tokensFreed, should not compact
      expect(shouldAutoCompact(messages, config, undefined, undefined, 200)).toBe(false);
    });
  });

  describe("circuit breaker", () => {
    it("starts with 0 failures and allows compaction", () => {
      const tracking = createAutoCompactTracking();
      expect(tracking.consecutiveFailures).toBe(0);
      expect(canAutoCompact(tracking)).toBe(true);
    });

    it("blocks after maxFailures consecutive failures", () => {
      const tracking = createAutoCompactTracking(3);
      recordAutoCompactFailure(tracking);
      expect(canAutoCompact(tracking)).toBe(true);
      recordAutoCompactFailure(tracking);
      expect(canAutoCompact(tracking)).toBe(true);
      recordAutoCompactFailure(tracking);
      expect(canAutoCompact(tracking)).toBe(false);
    });

    it("resets on success", () => {
      const tracking = createAutoCompactTracking(3);
      recordAutoCompactFailure(tracking);
      recordAutoCompactFailure(tracking);
      expect(tracking.consecutiveFailures).toBe(2);
      recordAutoCompactSuccess(tracking);
      expect(tracking.consecutiveFailures).toBe(0);
      expect(canAutoCompact(tracking)).toBe(true);
    });

    it("uses default maxFailures of 3", () => {
      const tracking = createAutoCompactTracking();
      expect(tracking.maxFailures).toBe(3);
    });

    it("accepts custom maxFailures", () => {
      const tracking = createAutoCompactTracking(5);
      expect(tracking.maxFailures).toBe(5);
    });
  });
});
