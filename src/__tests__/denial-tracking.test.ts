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

  it("triggers fallback when maxTotal is hit and resets all counts via resetAfterFallback", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 5 });

    for (let i = 0; i < 5; i++) {
      tracker.recordDenial();
    }
    expect(tracker.shouldFallback()).toBe(true);

    // shouldFallback is now pure — calling it again returns the same result
    expect(tracker.shouldFallback()).toBe(true);

    // resetAfterFallback resets both counters so auto mode can recover
    tracker.resetAfterFallback();
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(0);
    expect(tracker.shouldFallback()).toBe(false);
  });

  it("resetAfterFallback allows auto mode to recover after total limit", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 3 });

    tracker.recordDenial();
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);

    tracker.resetAfterFallback();
    tracker.recordSuccess();
    // Both counters were reset, so fallback is no longer triggered
    expect(tracker.shouldFallback()).toBe(false);
    expect(tracker.getState().totalDenials).toBe(0);
    expect(tracker.getState().consecutiveDenials).toBe(0);
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
