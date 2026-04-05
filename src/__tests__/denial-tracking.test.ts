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

  it("resetAfterFallback resets consecutive but preserves totalDenials", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 5 });

    for (let i = 0; i < 5; i++) {
      tracker.recordDenial();
    }
    expect(tracker.shouldFallback()).toBe(true);

    tracker.resetAfterFallback();
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(5);
    // Total limit still exceeded — shouldFallback stays true
    expect(tracker.shouldFallback()).toBe(true);
  });

  it("resetAfterFallback after consecutive limit allows recovery while preserving total", () => {
    const tracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 100 });

    tracker.recordDenial();
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);

    tracker.resetAfterFallback();
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(3);
    // Below total limit, consecutive reset — can proceed
    expect(tracker.shouldFallback()).toBe(false);
  });

  it("totalDenials accumulates across multiple fallback cycles", () => {
    const tracker = new DenialTracker({ maxConsecutive: 2, maxTotal: 5 });

    // First cycle: 2 denials → fallback → reset
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);
    tracker.resetAfterFallback();
    expect(tracker.getState().totalDenials).toBe(2);

    // Second cycle: 2 more denials → fallback → reset
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);
    tracker.resetAfterFallback();
    expect(tracker.getState().totalDenials).toBe(4);

    // Third cycle: 1 more denial hits total=5 limit
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);
    // This time shouldFallback stays true even after reset (total limit hit)
    tracker.resetAfterFallback();
    expect(tracker.shouldFallback()).toBe(true);
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
