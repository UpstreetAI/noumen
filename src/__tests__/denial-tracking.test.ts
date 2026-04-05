import { describe, it, expect } from "vitest";
import { DenialTracker } from "../permissions/denial-tracking.js";

describe("DenialTracker", () => {
  it("triggers fallback after maxConsecutive denials", () => {
    const tracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 100 });
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(false);
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);
  });

  it("resets consecutive count on success", () => {
    const tracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 100 });
    tracker.recordDenial();
    tracker.recordDenial();
    tracker.recordSuccess();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(false);
  });

  it("resets totalDenials when maxTotal is hit to prevent permanent fallback", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 5 });

    // Record 5 denials to hit maxTotal
    for (let i = 0; i < 5; i++) {
      tracker.recordDenial();
    }
    // First check triggers fallback and resets totalDenials
    expect(tracker.shouldFallback()).toBe(true);

    // After reset, totalDenials is 0 — subsequent calls should NOT fallback
    // (consecutiveDenials is still 5 though, so we need to reset that too)
    tracker.recordSuccess(); // resets consecutive
    expect(tracker.shouldFallback()).toBe(false);

    // Need another 5 denials to hit maxTotal again
    for (let i = 0; i < 4; i++) {
      tracker.recordDenial();
    }
    expect(tracker.shouldFallback()).toBe(false);
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);
  });

  it("does not permanently stay in fallback after totalDenials limit", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 3 });

    // Hit total limit
    tracker.recordDenial();
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);

    // Record successes - should recover
    tracker.recordSuccess();
    expect(tracker.shouldFallback()).toBe(false);

    // Can accumulate more denials before hitting limit again
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(false);
  });

  it("reset() clears all state", () => {
    const tracker = new DenialTracker({ maxConsecutive: 2, maxTotal: 5 });
    tracker.recordDenial();
    tracker.recordDenial();
    tracker.reset();
    expect(tracker.shouldFallback()).toBe(false);
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(0);
  });
});
