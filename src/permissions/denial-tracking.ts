export interface DenialLimits {
  maxConsecutive: number;
  maxTotal: number;
}

export interface DenialState {
  consecutiveDenials: number;
  totalDenials: number;
}

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

  constructor(limits?: Partial<DenialLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  recordDenial(): void {
    this.state.consecutiveDenials++;
    this.state.totalDenials++;
  }

  recordSuccess(): void {
    this.state.consecutiveDenials = 0;
  }

  shouldFallback(): boolean {
    return (
      this.state.consecutiveDenials >= this.limits.maxConsecutive ||
      this.state.totalDenials >= this.limits.maxTotal
    );
  }

  getState(): Readonly<DenialState> {
    return { ...this.state };
  }

  reset(): void {
    this.state.consecutiveDenials = 0;
    this.state.totalDenials = 0;
  }
}
