/**
 * Model catalogue: which models the app can run, what they cost, and what they can do.
 *
 * Rates are USD per 1,000,000 tokens and are the providers' list prices at the date in
 * RATES_CAPTURED_AT. They are only defaults: an administrator can override any rate in
 * Settings, and every recorded call stores the cost it was charged so history never
 * re-prices when a rate changes.
 */

export const LLM_PROVIDERS = ["anthropic", "openai", "gemini", "deepseek", "mock"] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

/** Providers whose key can be supplied from the dashboard (mock needs nothing). */
export const CONFIGURABLE_PROVIDERS = ["anthropic", "openai", "gemini", "deepseek"] as const;
export type ConfigurableProvider = (typeof CONFIGURABLE_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<LlmProviderName, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
  mock: "Mock (offline)",
};

/** Where to get an API key, shown next to the "add key" form. */
export const PROVIDER_KEY_HINTS: Record<ConfigurableProvider, { url: string; envVar: string }> = {
  anthropic: { url: "https://platform.claude.com/settings/keys", envVar: "ANTHROPIC_API_KEY" },
  openai: { url: "https://platform.openai.com/api-keys", envVar: "OPENAI_API_KEY" },
  gemini: { url: "https://aistudio.google.com/apikey", envVar: "GEMINI_API_KEY" },
  deepseek: { url: "https://platform.deepseek.com/api_keys", envVar: "DEEPSEEK_API_KEY" },
};

/** USD per 1M tokens. `cacheRead`/`cacheWrite` are null when the provider has no prompt cache. */
export interface ModelRates {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface ModelSpec {
  /** Stable key used in settings and stored rows: "<provider>:<model>". */
  key: string;
  provider: LlmProviderName;
  /** The id sent to the provider API. */
  model: string;
  label: string;
  /** Short note shown under the label in the picker. */
  note: string;
  contextWindow: number;
  maxOutput: number;
  rates: ModelRates;
  /**
   * Multiplier applied to every rate when the request goes through the provider's batch
   * endpoint; null when the provider has no batch API, so the model has no batch variant.
   */
  batchMultiplier: number | null;
  /** Can do grounded research with provider-side search (otherwise research uses the fetched website only). */
  webSearch: boolean;
  /** Native JSON-schema constrained output. All models here have it; kept explicit for future additions. */
  structuredOutput: boolean;
  /** Reasoning-effort control (maps to research intensity). */
  effort: boolean;
  tier: "flagship" | "balanced" | "fast";
  /** Retired/legacy models stay resolvable for history but are hidden from the picker. */
  deprecated?: boolean;
}

export const RATES_CAPTURED_AT = "2026-09-29";

function spec(s: Omit<ModelSpec, "key">): ModelSpec {
  return { ...s, key: `${s.provider}:${s.model}` };
}

export const MODEL_CATALOGUE: readonly ModelSpec[] = [
  // ---------- Anthropic ----------
  spec({
    provider: "anthropic",
    model: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    note: "Best all-round quality for research and drafting.",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    batchMultiplier: 0.5,
    webSearch: true,
    structuredOutput: true,
    effort: true,
    tier: "flagship",
  }),
  spec({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    note: "Half the price of Opus; strong enough for most drafting.",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    batchMultiplier: 0.5,
    webSearch: true,
    structuredOutput: true,
    effort: true,
    tier: "balanced",
  }),
  spec({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    note: "Cheapest Claude. Good for high-volume drafting, weaker research.",
    contextWindow: 200_000,
    maxOutput: 64_000,
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    batchMultiplier: 0.5,
    webSearch: false,
    structuredOutput: true,
    effort: false,
    tier: "fast",
  }),
  spec({
    provider: "anthropic",
    model: "claude-opus-5",
    label: "Claude Opus 5",
    note: "Previous Opus generation.",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    batchMultiplier: 0.5,
    webSearch: true,
    structuredOutput: true,
    effort: true,
    tier: "flagship",
  }),

  // ---------- OpenAI ----------
  spec({
    provider: "openai",
    model: "gpt-6-sol",
    label: "GPT-6 Sol",
    note: "OpenAI's balanced flagship.",
    contextWindow: 400_000,
    maxOutput: 128_000,
    rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: null },
    batchMultiplier: 0.5,
    webSearch: true,
    structuredOutput: true,
    effort: true,
    tier: "flagship",
  }),
  spec({
    provider: "openai",
    model: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    note: "Higher-reasoning option, twice the price of GPT-6 Sol.",
    contextWindow: 400_000,
    maxOutput: 128_000,
    rates: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: null },
    batchMultiplier: 0.5,
    webSearch: true,
    structuredOutput: true,
    effort: true,
    tier: "flagship",
  }),
  spec({
    provider: "openai",
    model: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    note: "Very cheap; fine for drafting at volume.",
    contextWindow: 400_000,
    maxOutput: 64_000,
    rates: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: null },
    batchMultiplier: 0.5,
    webSearch: false,
    structuredOutput: true,
    effort: true,
    tier: "fast",
  }),
  spec({
    provider: "openai",
    model: "gpt-6-luna",
    label: "GPT-6 Luna",
    note: "Cheapest model in the catalogue.",
    contextWindow: 400_000,
    maxOutput: 64_000,
    rates: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: null },
    batchMultiplier: 0.5,
    webSearch: false,
    structuredOutput: true,
    effort: true,
    tier: "fast",
  }),

  // ---------- Google Gemini ----------
  spec({
    provider: "gemini",
    model: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    note: "Fast and cheap with Google Search grounding.",
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    rates: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: null },
    batchMultiplier: 0.5,
    webSearch: true,
    structuredOutput: true,
    effort: false,
    tier: "balanced",
  }),
  spec({
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (preview)",
    note: "Gemini's strongest reasoning model. Rates apply up to a 200k prompt.",
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    rates: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: null },
    batchMultiplier: 0.5,
    webSearch: true,
    structuredOutput: true,
    effort: true,
    tier: "flagship",
  }),
  spec({
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    note: "Cheapest Gemini.",
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    rates: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: null },
    batchMultiplier: 0.5,
    webSearch: false,
    structuredOutput: true,
    effort: false,
    tier: "fast",
  }),

  // ---------- DeepSeek (OpenAI-compatible endpoint, no batch API) ----------
  spec({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    note: "Very cheap reasoning model. No batch API; off-peak hours are half price.",
    contextWindow: 128_000,
    maxOutput: 32_000,
    rates: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: null },
    batchMultiplier: null,
    webSearch: false,
    structuredOutput: true,
    effort: false,
    tier: "balanced",
  }),
  spec({
    provider: "deepseek",
    model: "deepseek-flash",
    label: "DeepSeek Flash",
    note: "Lowest cost per draft of any provider. No batch API.",
    contextWindow: 128_000,
    maxOutput: 32_000,
    rates: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: null },
    batchMultiplier: null,
    webSearch: false,
    structuredOutput: true,
    effort: false,
    tier: "fast",
  }),

  // ---------- Mock ----------
  spec({
    provider: "mock",
    model: "mock",
    label: "Mock provider",
    note: "Deterministic offline output. Free, and simulates a batch endpoint for testing.",
    contextWindow: 200_000,
    maxOutput: 8_000,
    rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: null },
    // Not a real endpoint: batch items are executed inline so the batch flow can be exercised
    // end to end without a provider. Rates are zero unless an administrator overrides them.
    batchMultiplier: 0.5,
    webSearch: false,
    structuredOutput: true,
    effort: false,
    tier: "fast",
  }),
];

const BY_KEY = new Map(MODEL_CATALOGUE.map((m) => [m.key, m]));
/** Bare model ids resolve too, so pre-existing settings like "claude-opus-5" keep working. */
const BY_MODEL = new Map(MODEL_CATALOGUE.map((m) => [m.model, m]));

/**
 * A model choice as stored in settings and on campaigns: the catalogue key, optionally
 * suffixed with "@batch" to route through the provider's batch endpoint.
 */
export const BATCH_SUFFIX = "@batch";

export interface ModelChoice {
  spec: ModelSpec;
  batch: boolean;
  /** The canonical string form, i.e. what should be stored. */
  value: string;
}

export function formatModelChoice(key: string, batch: boolean): string {
  return batch ? `${key}${BATCH_SUFFIX}` : key;
}

/** Parse a stored selection. Returns null for an unknown model so callers can fall back. */
export function parseModelChoice(value: string | null | undefined): ModelChoice | null {
  if (!value) return null;
  const batch = value.endsWith(BATCH_SUFFIX);
  const key = batch ? value.slice(0, -BATCH_SUFFIX.length) : value;
  const found = BY_KEY.get(key) ?? BY_MODEL.get(key);
  if (!found) return null;
  // A stored batch selection on a model that cannot batch degrades to a normal call.
  const canBatch = batch && found.batchMultiplier !== null;
  return { spec: found, batch: canBatch, value: formatModelChoice(found.key, canBatch) };
}

export function findModelSpec(keyOrModel: string): ModelSpec | null {
  return BY_KEY.get(keyOrModel) ?? BY_MODEL.get(keyOrModel) ?? null;
}

/** Every selectable option, normal and batch, in picker order. */
export function modelOptions(opts: { includeMock?: boolean } = {}): Array<{ value: string; spec: ModelSpec; batch: boolean }> {
  const out: Array<{ value: string; spec: ModelSpec; batch: boolean }> = [];
  for (const m of MODEL_CATALOGUE) {
    if (m.deprecated) continue;
    if (m.provider === "mock" && !opts.includeMock) continue;
    out.push({ value: m.key, spec: m, batch: false });
    if (m.batchMultiplier !== null) out.push({ value: formatModelChoice(m.key, true), spec: m, batch: true });
  }
  return out;
}

// ---------- Research intensity ----------

export const RESEARCH_MODES = ["normal", "great", "advance"] as const;
export type ResearchMode = (typeof RESEARCH_MODES)[number];

export interface ResearchModeProfile {
  label: string;
  description: string;
  /** Reasoning effort passed to models that support it. */
  effort: "low" | "medium" | "high";
  /** Provider-side search / fetch budgets. 0 disables the tool. */
  maxSearches: number;
  maxFetches: number;
  /** Agentic loop cap while the model is still calling tools. */
  maxIterations: number;
  /** Output ceiling for the research phase. */
  maxOutputTokens: number;
  /** Expected token spend per lead, used for the pre-flight cost estimate. */
  estimate: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

/**
 * The three intensities. Token estimates are deliberately conservative averages measured
 * against the shipped research prompt; the API blends them with a campaign's own observed
 * averages once it has enough completed calls.
 */
export const RESEARCH_MODE_PROFILES: Record<ResearchMode, ResearchModeProfile> = {
  normal: {
    label: "Normal",
    description: "One pass. Uses the lead's website plus up to two searches. Cheapest, least depth.",
    effort: "low",
    maxSearches: 2,
    maxFetches: 1,
    maxIterations: 2,
    maxOutputTokens: 4_000,
    estimate: { inputTokens: 9_000, cachedInputTokens: 0, outputTokens: 1_800 },
  },
  great: {
    label: "Great",
    description: "Verifies the company and the person across several sources. The sensible default.",
    effort: "medium",
    maxSearches: 5,
    maxFetches: 3,
    maxIterations: 4,
    maxOutputTokens: 8_000,
    estimate: { inputTokens: 28_000, cachedInputTokens: 0, outputTokens: 4_200 },
  },
  advance: {
    label: "Advance",
    description: "Deep dig: recent signals, hiring, funding, the person's own posts. Several times the cost.",
    effort: "high",
    maxSearches: 10,
    maxFetches: 6,
    maxIterations: 6,
    maxOutputTokens: 16_000,
    estimate: { inputTokens: 75_000, cachedInputTokens: 0, outputTokens: 9_000 },
  },
};

/** Expected token spend for one drafted email. The stable prefix is cached after the first lead. */
export const DRAFT_ESTIMATE = { inputTokens: 2_400, cachedInputTokens: 6_500, outputTokens: 1_100 };

/** Second phase of research: turning findings into the persona JSON. Runs at low effort. */
export const PERSONA_STRUCTURE_ESTIMATE = { inputTokens: 3_000, cachedInputTokens: 0, outputTokens: 1_200 };

// ---------- Batch strategy ----------

/**
 * How batched requests are grouped.
 * campaign_start: everything the campaign needs goes out as one batch, so nothing appears
 *   until the provider finishes (minutes to 24h). Cheapest and simplest.
 * rolling: requests accumulate and flush on a timer or a size trigger, so drafts trickle in.
 */
export const BATCH_STRATEGIES = ["campaign_start", "rolling"] as const;
export type BatchStrategy = (typeof BATCH_STRATEGIES)[number];

export const BATCH_STRATEGY_LABELS: Record<BatchStrategy, string> = {
  campaign_start: "One batch per campaign",
  rolling: "Rolling batches",
};

/** Lifecycle of a submitted batch. */
export const BATCH_STATUSES = ["pending", "submitted", "processing", "completed", "failed", "cancelled", "expired"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const OPEN_BATCH_STATUSES: ReadonlySet<BatchStatus> = new Set<BatchStatus>(["submitted", "processing"]);

export const BATCH_ITEM_STATUSES = ["pending", "submitted", "succeeded", "errored", "expired", "abandoned"] as const;
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number];

export const LLM_PURPOSES = ["research", "persona", "draft"] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];
