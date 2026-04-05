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

  it("resetAfterFallback resets both consecutive and total denials", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 5 });

    for (let i = 0; i < 5; i++) {
      tracker.recordDenial();
    }
    expect(tracker.shouldFallback()).toBe(true);

    tracker.resetAfterFallback();
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(0);
    // Both counters reset — shouldFallback is now false
    expect(tracker.shouldFallback()).toBe(false);
  });

  it("resetAfterFallback after consecutive limit resets both counters and allows recovery", () => {
    const tracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 100 });

    tracker.recordDenial();
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);

    tracker.resetAfterFallback();
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(0);
    expect(tracker.shouldFallback()).toBe(false);
  });

  it("totalDenials resets on fallback so tracker can recover", () => {
    const tracker = new DenialTracker({ maxConsecutive: 2, maxTotal: 5 });

    // First cycle: 2 denials → fallback → reset
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);
    tracker.resetAfterFallback();
    expect(tracker.getState().totalDenials).toBe(0);
    expect(tracker.shouldFallback()).toBe(false);

    // Second cycle: 2 more denials → fallback → reset
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);
    tracker.resetAfterFallback();
    expect(tracker.getState().totalDenials).toBe(0);

    // Can keep cycling without permanent lockout
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

  it("resetAfterFallback resets both consecutiveDenials and totalDenials", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 5 });
    for (let i = 0; i < 5; i++) tracker.recordDenial();
    expect(tracker.shouldFallback()).toBe(true);

    tracker.resetAfterFallback();
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(0);
    expect(tracker.shouldFallback()).toBe(false);
  });
});
