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

  it("triggers fallback when maxTotal is hit and resets consecutive via resetAfterFallback", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 5 });

    for (let i = 0; i < 5; i++) {
      tracker.recordDenial();
    }
    expect(tracker.shouldFallback()).toBe(true);

    // shouldFallback is now pure — calling it again returns the same result
    expect(tracker.shouldFallback()).toBe(true);

    // resetAfterFallback only resets consecutive, totalDenials stays monotonic
    tracker.resetAfterFallback();
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(5);
    // totalDenials is still at limit, so shouldFallback remains true
    expect(tracker.shouldFallback()).toBe(true);
  });

  it("totalDenials is monotonic — resetAfterFallback does not clear it", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 3 });

    tracker.recordDenial();
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);

    tracker.resetAfterFallback();
    tracker.recordSuccess();
    // totalDenials still at 3 (the max), so fallback stays true
    expect(tracker.shouldFallback()).toBe(true);
    expect(tracker.getState().totalDenials).toBe(3);
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
