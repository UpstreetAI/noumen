export interface DenialLimits {
  maxConsecutive: number;
  maxTotal: number;
}

export interface DenialState {
  consecutiveDenials: number;
  totalDenials: number;
}

export type FallbackCheck =
  | { triggered: false }
  | { triggered: true; reason: "consecutive" | "total" | "repeated_consecutive" };

const DEFAULT_LIMITS: DenialLimits = {
  maxConsecutive: 3,
  maxTotal: 20,
};

/**
 * Tracks permission denials and determines when limits are exceeded.
 * When limits are hit, the system should fall back to prompting or abort.
 */
export class DenialTracker {
  private state: DenialState = { consecutiveDenials: 0, totalDenials: 0 };
  private limits: DenialLimits;
  private consecutiveFallbacksWithoutSuccess = 0;

  constructor(limits?: Partial<DenialLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  recordDenial(): void {
    this.state.consecutiveDenials++;
    this.state.totalDenials++;
  }

  recordSuccess(): void {
    this.state.consecutiveDenials = 0;
    this.consecutiveFallbacksWithoutSuccess = 0;
  }

  shouldFallback(): FallbackCheck {
    if (this.state.totalDenials >= this.limits.maxTotal) {
      return { triggered: true, reason: "total" };
    }
    if (this.state.consecutiveDenials >= this.limits.maxConsecutive) {
      return {
        triggered: true,
        reason: this.consecutiveFallbacksWithoutSuccess > 0
          ? "repeated_consecutive"
          : "consecutive",
      };
    }
    return { triggered: false };
  }

  /**
   * Reset counters after a fallback. Only resets totalDenials when the
   * total limit was the trigger — consecutive-only fallbacks preserve
   * the total counter so the session-wide safety net stays effective.
   *
   * Tracks repeated consecutive fallbacks: if `resetAfterFallback("consecutive")`
   * is called again without an intervening `recordSuccess()`, the next
   * `shouldFallback()` returns `"repeated_consecutive"` to signal escalation.
   */
  resetAfterFallback(trigger: "consecutive" | "total"): void {
    this.state.consecutiveDenials = 0;
    if (trigger === "consecutive") {
      this.consecutiveFallbacksWithoutSuccess++;
    }
    if (trigger === "total") {
      this.state.totalDenials = 0;
      this.consecutiveFallbacksWithoutSuccess = 0;
    }
  }

  getState(): Readonly<DenialState> {
    return { ...this.state };
  }

  reset(): void {
    this.state.consecutiveDenials = 0;
    this.state.totalDenials = 0;
    this.consecutiveFallbacksWithoutSuccess = 0;
  }
}
