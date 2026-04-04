import type { ModelPricing, UsageRecord, ModelUsageSummary, CostSummary } from "./types.js";
import { calculateCost, DEFAULT_PRICING } from "./pricing.js";

export interface StoredCostState {
  byModel: Record<string, ModelUsageSummary>;
  totalApiMs: number;
  wallStartMs: number;
}

export class CostTracker {
  private pricing: Record<string, ModelPricing>;
  private byModel: Record<string, ModelUsageSummary> = {};
  private totalApiMs = 0;
  private wallStartMs = Date.now();

  constructor(pricing?: Record<string, ModelPricing>) {
    this.pricing = pricing ?? DEFAULT_PRICING;
  }

  addUsage(model: string, usage: UsageRecord, apiDurationMs?: number): CostSummary {
    const cost = calculateCost(model, usage, this.pricing);

    if (!this.byModel[model]) {
      this.byModel[model] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
      };
    }

    const m = this.byModel[model];
    m.inputTokens += usage.prompt_tokens;
    m.outputTokens += usage.completion_tokens;
    m.cacheReadTokens += usage.cache_read_tokens ?? 0;
    m.cacheCreationTokens += usage.cache_creation_tokens ?? 0;
    m.costUSD += cost;

    if (apiDurationMs !== undefined) {
      this.totalApiMs += apiDurationMs;
    }

    return this.getSummary();
  }

  getSummary(): CostSummary {
    let totalCostUSD = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;

    for (const m of Object.values(this.byModel)) {
      totalCostUSD += m.costUSD;
      totalInputTokens += m.inputTokens;
      totalOutputTokens += m.outputTokens;
      totalCacheReadTokens += m.cacheReadTokens;
      totalCacheCreationTokens += m.cacheCreationTokens;
    }

    return {
      totalCostUSD,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      byModel: { ...this.byModel },
      duration: {
        apiMs: this.totalApiMs,
        wallMs: Date.now() - this.wallStartMs,
      },
    };
  }

  reset(): void {
    this.byModel = {};
    this.totalApiMs = 0;
    this.wallStartMs = Date.now();
  }

  getState(): StoredCostState {
    return {
      byModel: structuredClone(this.byModel),
      totalApiMs: this.totalApiMs,
      wallStartMs: this.wallStartMs,
    };
  }

  restore(state: StoredCostState): void {
    this.byModel = structuredClone(state.byModel);
    this.totalApiMs = state.totalApiMs;
    this.wallStartMs = state.wallStartMs;
  }

  formatSummary(): string {
    const s = this.getSummary();
    const costStr = s.totalCostUSD > 0.5
      ? `$${s.totalCostUSD.toFixed(2)}`
      : `$${s.totalCostUSD.toFixed(4)}`;

    const lines = [`Total cost: ${costStr}`];

    const models = Object.entries(s.byModel);
    if (models.length > 0) {
      lines.push("Usage by model:");
      for (const [model, m] of models) {
        const parts = [
          `${formatNum(m.inputTokens)} input`,
          `${formatNum(m.outputTokens)} output`,
        ];
        if (m.cacheReadTokens > 0) parts.push(`${formatNum(m.cacheReadTokens)} cache read`);
        if (m.cacheCreationTokens > 0) parts.push(`${formatNum(m.cacheCreationTokens)} cache write`);
        parts.push(`($${m.costUSD.toFixed(4)})`);
        lines.push(`  ${model}: ${parts.join(", ")}`);
      }
    }

    return lines.join("\n");
  }
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
