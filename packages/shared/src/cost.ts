/**
 * Cost arithmetic. Everything is carried as integer micro-dollars (1e-6 USD) so sums stay
 * exact in Postgres and in JavaScript; only the display layer converts to dollars.
 */
import {
  DRAFT_ESTIMATE,
  PERSONA_STRUCTURE_ESTIMATE,
  RESEARCH_MODE_PROFILES,
  type ModelRates,
  type ResearchMode,
} from "./models.js";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export const MICRO_PER_USD = 1_000_000;

export function microToUsd(micro: number): number {
  return micro / MICRO_PER_USD;
}

/** Rates with the batch discount already applied. */
export function effectiveRates(rates: ModelRates, batch: boolean, batchMultiplier: number | null): ModelRates {
  if (!batch || batchMultiplier === null) return rates;
  const m = batchMultiplier;
  return {
    input: rates.input * m,
    output: rates.output * m,
    cacheRead: rates.cacheRead === null ? null : rates.cacheRead * m,
    cacheWrite: rates.cacheWrite === null ? null : rates.cacheWrite * m,
  };
}

/**
 * Cost of one call in micro-dollars. Cached reads and writes fall back to the input rate
 * when the provider does not price them separately, so a missing rate never under-reports.
 */
export function costMicroUsd(usage: TokenUsage, rates: ModelRates): number {
  const perToken = (ratePerMillion: number) => ratePerMillion / 1_000_000;
  const total =
    usage.inputTokens * perToken(rates.input) +
    usage.outputTokens * perToken(rates.output) +
    usage.cacheReadTokens * perToken(rates.cacheRead ?? rates.input) +
    usage.cacheWriteTokens * perToken(rates.cacheWrite ?? rates.input);
  return Math.round(total * MICRO_PER_USD);
}

// ---------- Pre-flight estimation ----------

export interface CostEstimateInput {
  /** Leads that still need research (0 once every lead has a persona). */
  leadsToResearch: number;
  /** Emails still to be drafted across the whole sequence. */
  emailsToDraft: number;
  researchMode: ResearchMode;
  /**
   * Rates to price with, already resolved: batch discount and any administrator override
   * applied. Passing resolved rates rather than a model keeps the projection and the actual
   * charge in step.
   */
  researchRates: ModelRates;
  draftRates: ModelRates;
  /**
   * Per-purpose observed averages, when the campaign has enough history to beat the static
   * profile. Supply micro-dollars per call; omit to use the profile estimate.
   */
  observed?: { researchMicroPerLead?: number; draftMicroPerEmail?: number };
}

export interface CostEstimateLine {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  microUsd: number;
  /** True when this line came from the campaign's own measured calls rather than the profile. */
  measured: boolean;
}

export interface CostEstimate {
  research: CostEstimateLine;
  draft: CostEstimateLine;
  totalMicroUsd: number;
  perLeadMicroUsd: number;
  perEmailMicroUsd: number;
  totalTokens: number;
}

function lineFor(
  calls: number,
  estimates: Array<{ inputTokens: number; cachedInputTokens: number; outputTokens: number }>,
  rates: ModelRates,
  observedMicroPerCall: number | undefined,
): CostEstimateLine {
  const per = estimates.reduce(
    (acc, e) => ({
      inputTokens: acc.inputTokens + e.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + e.cachedInputTokens,
      outputTokens: acc.outputTokens + e.outputTokens,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  );
  const microPerCall =
    observedMicroPerCall ??
    costMicroUsd(
      { inputTokens: per.inputTokens, outputTokens: per.outputTokens, cacheReadTokens: per.cachedInputTokens, cacheWriteTokens: 0 },
      rates,
    );
  return {
    calls,
    inputTokens: per.inputTokens * calls,
    cachedInputTokens: per.cachedInputTokens * calls,
    outputTokens: per.outputTokens * calls,
    microUsd: microPerCall * calls,
    measured: observedMicroPerCall !== undefined,
  };
}

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const profile = RESEARCH_MODE_PROFILES[input.researchMode];
  // Research is two calls per lead: the agentic findings pass, then persona structuring.
  const research = lineFor(
    input.leadsToResearch,
    [profile.estimate, PERSONA_STRUCTURE_ESTIMATE],
    input.researchRates,
    input.observed?.researchMicroPerLead,
  );
  const draft = lineFor(input.emailsToDraft, [DRAFT_ESTIMATE], input.draftRates, input.observed?.draftMicroPerEmail);
  const totalMicroUsd = research.microUsd + draft.microUsd;
  return {
    research,
    draft,
    totalMicroUsd,
    perLeadMicroUsd: input.leadsToResearch > 0 ? Math.round(totalMicroUsd / input.leadsToResearch) : 0,
    perEmailMicroUsd: input.emailsToDraft > 0 ? Math.round(draft.microUsd / input.emailsToDraft) : 0,
    totalTokens:
      research.inputTokens + research.cachedInputTokens + research.outputTokens + draft.inputTokens + draft.cachedInputTokens + draft.outputTokens,
  };
}

/**
 * Format micro-dollars for the dashboard. Per-email numbers are fractions of a cent, so
 * small values get more decimals rather than rounding to "$0.00".
 */
export function formatUsd(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return "—";
  const usd = microToUsd(micro);
  if (usd === 0) return "$0";
  const abs = Math.abs(usd);
  if (abs < 0.01) return `$${usd.toFixed(4)}`;
  if (abs < 1) return `$${usd.toFixed(3)}`;
  if (abs < 1000) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
