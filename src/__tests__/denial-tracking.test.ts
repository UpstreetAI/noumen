import { describe, it, expect } from "vitest";
import { DenialTracker } from "../permissions/denial-tracking.js";

describe("DenialTracker", () => {
  it("triggers fallback after maxConsecutive denials", () => {
    const tracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 100 });
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.shouldFallback().triggered).toBe(false);
    tracker.recordDenial();
    const result = tracker.shouldFallback();
    expect(result.triggered).toBe(true);
    if (result.triggered) expect(result.reason).toBe("consecutive");
  });

  it("triggers fallback after maxTotal denials", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 5 });
    for (let i = 0; i < 5; i++) tracker.recordDenial();
    const result = tracker.shouldFallback();
    expect(result.triggered).toBe(true);
    if (result.triggered) expect(result.reason).toBe("total");
  });

  it("resets consecutive count on success", () => {
    const tracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 100 });
    tracker.recordDenial();
    tracker.recordDenial();
    tracker.recordSuccess();
    tracker.recordDenial();
    expect(tracker.shouldFallback().triggered).toBe(false);
  });

  it("consecutive fallback preserves totalDenials count", () => {
    const tracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 20 });
    tracker.recordDenial();
    tracker.recordDenial();
    tracker.recordDenial();
    const result = tracker.shouldFallback();
    expect(result.triggered).toBe(true);
    if (result.triggered) expect(result.reason).toBe("consecutive");

    tracker.resetAfterFallback("consecutive");
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(3);
  });

  it("total fallback resets both counters", () => {
    const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 5 });
    for (let i = 0; i < 5; i++) tracker.recordDenial();
    const result = tracker.shouldFallback();
    expect(result.triggered).toBe(true);
    if (result.triggered) expect(result.reason).toBe("total");

    tracker.resetAfterFallback("total");
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(0);
    expect(tracker.shouldFallback().triggered).toBe(false);
  });

  it("cycling through consecutive fallbacks eventually hits total limit", () => {
    const tracker = new DenialTracker({ maxConsecutive: 2, maxTotal: 7 });

    // Cycle 1: 2 denials → consecutive fallback
    tracker.recordDenial();
    tracker.recordDenial();
    let fb = tracker.shouldFallback();
    expect(fb.triggered && fb.reason).toBe("consecutive");
    tracker.resetAfterFallback("consecutive");
    expect(tracker.getState().totalDenials).toBe(2);

    // Cycle 2: 2 more denials → consecutive fallback (total now 4)
    tracker.recordDenial();
    tracker.recordDenial();
    fb = tracker.shouldFallback();
    expect(fb.triggered && fb.reason).toBe("consecutive");
    tracker.resetAfterFallback("consecutive");
    expect(tracker.getState().totalDenials).toBe(4);

    // Cycle 3: 2 more denials → consecutive (total now 6), 1 more → total=7
    tracker.recordDenial();
    tracker.recordDenial();
    fb = tracker.shouldFallback();
    expect(fb.triggered && fb.reason).toBe("consecutive");
    tracker.resetAfterFallback("consecutive");
    expect(tracker.getState().totalDenials).toBe(6);

    // One more denial → total hits 7 = maxTotal
    tracker.recordDenial();
    fb = tracker.shouldFallback();
    expect(fb.triggered).toBe(true);
    if (fb.triggered) expect(fb.reason).toBe("total");
  });

  it("total limit takes priority over consecutive when both hit simultaneously", () => {
    const tracker = new DenialTracker({ maxConsecutive: 5, maxTotal: 5 });
    for (let i = 0; i < 5; i++) tracker.recordDenial();
    const fb = tracker.shouldFallback();
    expect(fb.triggered).toBe(true);
    if (fb.triggered) expect(fb.reason).toBe("total");
  });

  it("reset() clears all state", () => {
    const tracker = new DenialTracker({ maxConsecutive: 2, maxTotal: 5 });
    tracker.recordDenial();
    tracker.recordDenial();
    tracker.reset();
    expect(tracker.shouldFallback().triggered).toBe(false);
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(0);
  });
});
