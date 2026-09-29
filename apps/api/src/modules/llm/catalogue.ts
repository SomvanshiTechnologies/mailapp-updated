import {
  DRAFT_ESTIMATE,
  MODEL_CATALOGUE,
  PERSONA_STRUCTURE_ESTIMATE,
  PROVIDER_KEY_HINTS,
  PROVIDER_LABELS,
  RESEARCH_MODE_PROFILES,
  costMicroUsd,
  effectiveRates,
  findModelSpec,
  formatModelChoice,
  modelOptions,
  parseModelChoice,
  type CampaignAiConfig,
  type LlmProviderName,
  type ModelChoice,
  type ModelOptionDto,
  type ModelRates,
  type ResearchMode,
  type ResearchModeProfile,
  type ResolvedAiConfig,
  type SettingsDto,
} from "@mailapp/shared";
import type { CampaignRow } from "../../db/schema.js";

/**
 * A model choice with its rates already resolved (batch discount and any administrator
 * override applied) and the research profile attached. This is what every provider adapter
 * receives, so no adapter has to know about settings or pricing.
 */
export interface ResolvedModel {
  choice: ModelChoice;
  provider: LlmProviderName;
  /** The raw id sent to the provider. */
  model: string;
  /** Catalogue key, stored on every recorded call. */
  modelKey: string;
  batch: boolean;
  /** Rates actually charged, used to price the call. */
  rates: ModelRates;
  /** List rates before the batch discount, for display. */
  listRates: ModelRates;
  label: string;
  maxOutput: number;
  supportsWebSearch: boolean;
  supportsEffort: boolean;
}

/** Everything the pipeline needs to run one campaign's AI work. */
export interface CampaignModelPlan {
  research: ResolvedModel;
  draft: ResolvedModel;
  researchMode: ResearchMode;
  profile: ResearchModeProfile;
  resolved: ResolvedAiConfig;
}

const DEFAULT_MODEL = "anthropic:claude-opus-5-5";

/** Apply an administrator's rate override to a catalogue model. */
function ratesFor(modelKey: string, listRates: ModelRates, overrides: SettingsDto["modelRateOverrides"]): ModelRates {
  const o = overrides?.[modelKey];
  if (!o) return listRates;
  return {
    input: o.input,
    output: o.output,
    cacheRead: o.cacheRead === undefined ? listRates.cacheRead : o.cacheRead,
    cacheWrite: o.cacheWrite === undefined ? listRates.cacheWrite : o.cacheWrite,
  };
}

/**
 * Turn a stored selection into a ResolvedModel. An unknown selection falls back to the
 * organisation default and then to the built-in default, so a retired model can never stop
 * the pipeline; `forceMock` short-circuits everything for tests and dry runs.
 */
export function resolveModel(
  selection: string | undefined | null,
  settings: SettingsDto,
  opts: { fallback?: string; forceMock?: boolean } = {},
): ResolvedModel {
  const requested = parseModelChoice(selection) ?? parseModelChoice(opts.fallback) ?? parseModelChoice(DEFAULT_MODEL)!;
  if (opts.forceMock) {
    // Substitute the offline provider but keep the batch flag, so a batch selection still
    // drives the whole batch state machine (the mock "batch" runs its items inline).
    const mock = findModelSpec("mock:mock")!;
    const listRates = ratesFor(mock.key, mock.rates, settings.modelRateOverrides);
    const batch = requested.batch;
    return {
      choice: { spec: mock, batch, value: formatModelChoice(mock.key, batch) },
      provider: "mock",
      model: mock.model,
      modelKey: mock.key,
      batch,
      rates: effectiveRates(listRates, batch, mock.batchMultiplier),
      listRates,
      label: mock.label,
      maxOutput: mock.maxOutput,
      supportsWebSearch: false,
      supportsEffort: false,
    };
  }
  const choice = requested;
  const spec = choice.spec;
  const listRates = ratesFor(spec.key, spec.rates, settings.modelRateOverrides);
  return {
    choice,
    provider: spec.provider,
    model: spec.model,
    modelKey: spec.key,
    batch: choice.batch,
    rates: effectiveRates(listRates, choice.batch, spec.batchMultiplier),
    listRates,
    label: spec.label,
    maxOutput: spec.maxOutput,
    supportsWebSearch: spec.webSearch,
    supportsEffort: spec.effort,
  };
}

/**
 * Resolve a campaign's effective AI configuration. A campaign stores only the fields it
 * deliberately overrides, so anything absent falls through to the organisation settings.
 */
export function resolveCampaignPlan(
  settings: SettingsDto,
  campaign: Pick<CampaignRow, "aiConfig"> | null,
  opts: { forceMock?: boolean } = {},
): CampaignModelPlan {
  const ai = (campaign?.aiConfig ?? null) as CampaignAiConfig | null;
  const overridden: Array<keyof CampaignAiConfig> = [];
  for (const k of ["researchModel", "draftModel", "researchMode", "batchStrategy"] as const) {
    if (ai?.[k] !== undefined) overridden.push(k);
  }
  const research = resolveModel(ai?.researchModel ?? settings.researchModel, settings, opts);
  const draft = resolveModel(ai?.draftModel ?? settings.llmModel, settings, opts);
  // `resolved` describes the configuration, not the substitution: in mock mode the calls run
  // offline but an operator must still see which models the campaign is set to use.
  const configuredResearch = resolveModel(ai?.researchModel ?? settings.researchModel, settings);
  const configuredDraft = resolveModel(ai?.draftModel ?? settings.llmModel, settings);
  const researchMode = ai?.researchMode ?? settings.researchMode;
  const batchStrategy = ai?.batchStrategy ?? settings.batchStrategy;
  return {
    research,
    draft,
    researchMode,
    profile: RESEARCH_MODE_PROFILES[researchMode],
    resolved: {
      researchModel: configuredResearch.choice.value,
      researchModelLabel: configuredResearch.label,
      researchBatch: configuredResearch.batch,
      draftModel: configuredDraft.choice.value,
      draftModelLabel: configuredDraft.label,
      draftBatch: configuredDraft.batch,
      researchMode,
      batchStrategy,
      overridden,
      usesBatch: configuredResearch.batch || configuredDraft.batch,
    },
  };
}

/**
 * The picker's options, with rates after overrides and an indicative per-lead / per-email
 * cost so an operator can compare models without doing the arithmetic.
 */
export function modelOptionDtos(settings: SettingsDto, available: ReadonlySet<LlmProviderName>, includeMock: boolean): ModelOptionDto[] {
  const profile = RESEARCH_MODE_PROFILES[settings.researchMode];
  return modelOptions({ includeMock }).map(({ value, spec, batch }) => {
    const listRates = ratesFor(spec.key, spec.rates, settings.modelRateOverrides);
    const rates = effectiveRates(listRates, batch, spec.batchMultiplier);
    const research =
      costMicroUsd({ inputTokens: profile.estimate.inputTokens, outputTokens: profile.estimate.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, rates) +
      costMicroUsd({ inputTokens: PERSONA_STRUCTURE_ESTIMATE.inputTokens, outputTokens: PERSONA_STRUCTURE_ESTIMATE.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, rates);
    const draft = costMicroUsd(
      {
        inputTokens: DRAFT_ESTIMATE.inputTokens,
        outputTokens: DRAFT_ESTIMATE.outputTokens,
        cacheReadTokens: DRAFT_ESTIMATE.cachedInputTokens,
        cacheWriteTokens: 0,
      },
      rates,
    );
    return {
      value,
      modelKey: spec.key,
      provider: spec.provider,
      providerLabel: PROVIDER_LABELS[spec.provider],
      model: spec.model,
      label: spec.label,
      note: spec.note,
      batch,
      available: available.has(spec.provider),
      tier: spec.tier,
      webSearch: spec.webSearch,
      effort: spec.effort,
      contextWindow: spec.contextWindow,
      rates,
      rateOverridden: Boolean(settings.modelRateOverrides?.[spec.key]),
      indicative: { researchMicroUsd: research, draftMicroUsd: draft },
    };
  });
}

/** How many catalogue models each provider owns, for the API-keys card. */
export function modelCountByProvider(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MODEL_CATALOGUE) {
    if (m.deprecated || m.provider === "mock") continue;
    out[m.provider] = (out[m.provider] ?? 0) + 1;
  }
  return out;
}

export { PROVIDER_KEY_HINTS, PROVIDER_LABELS };
