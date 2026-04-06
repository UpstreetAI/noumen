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

  it("cycling through consecutive fallbacks with user approval in between stays at consecutive", () => {
    const tracker = new DenialTracker({ maxConsecutive: 2, maxTotal: 100 });

    // Cycle 1: 2 denials → consecutive fallback
    tracker.recordDenial();
    tracker.recordDenial();
    let fb = tracker.shouldFallback();
    expect(fb.triggered && fb.reason).toBe("consecutive");
    tracker.resetAfterFallback("consecutive");
    expect(tracker.getState().totalDenials).toBe(2);

    // User approves (breaks the repeated cycle)
    tracker.recordSuccess();

    // Cycle 2: 2 more denials → still "consecutive" (not repeated)
    tracker.recordDenial();
    tracker.recordDenial();
    fb = tracker.shouldFallback();
    expect(fb.triggered && fb.reason).toBe("consecutive");
    tracker.resetAfterFallback("consecutive");
    expect(tracker.getState().totalDenials).toBe(4);

    // User approves again
    tracker.recordSuccess();

    // Cycle 3: 2 more denials → still "consecutive"
    tracker.recordDenial();
    tracker.recordDenial();
    fb = tracker.shouldFallback();
    expect(fb.triggered && fb.reason).toBe("consecutive");
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

  it("repeated consecutive fallback without success escalates to repeated_consecutive", () => {
    const tracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 100 });

    // First cycle: 3 denials → consecutive fallback → reset
    for (let i = 0; i < 3; i++) tracker.recordDenial();
    let fb = tracker.shouldFallback();
    expect(fb.triggered).toBe(true);
    if (fb.triggered) expect(fb.reason).toBe("consecutive");
    tracker.resetAfterFallback("consecutive");

    // Headless: no user approval (no recordSuccess call)
    // Second cycle: 3 more denials → should escalate
    for (let i = 0; i < 3; i++) tracker.recordDenial();
    fb = tracker.shouldFallback();
    expect(fb.triggered).toBe(true);
    if (fb.triggered) expect(fb.reason).toBe("repeated_consecutive");
  });

  it("recordSuccess between consecutive fallbacks prevents escalation", () => {
    const tracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 100 });

    // First cycle: 3 denials → consecutive fallback → reset
    for (let i = 0; i < 3; i++) tracker.recordDenial();
    let fb = tracker.shouldFallback();
    expect(fb.triggered && fb.reason).toBe("consecutive");
    tracker.resetAfterFallback("consecutive");

    // User approves (recordSuccess)
    tracker.recordSuccess();

    // Second cycle: 3 denials → still "consecutive" (not escalated)
    for (let i = 0; i < 3; i++) tracker.recordDenial();
    fb = tracker.shouldFallback();
    expect(fb.triggered).toBe(true);
    if (fb.triggered) expect(fb.reason).toBe("consecutive");
  });
});
