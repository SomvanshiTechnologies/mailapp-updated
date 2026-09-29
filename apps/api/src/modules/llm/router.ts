import type { DraftOutput, Persona } from "@mailapp/shared";
import { AppError } from "../../lib/errors.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import type { Logger } from "../../observability/logger.js";
import type { MetricsSink } from "../../observability/metrics.js";
import { AnthropicAdapter } from "./anthropic.js";
import { ProviderCredentialStore } from "./credentials.js";
import { GeminiAdapter } from "./gemini.js";
import { MockLlmAdapter } from "./mock.js";
import { OpenAiAdapter } from "./openai.js";
import type { DraftInput, LlmAdapter, LlmDeps, LlmProvider, LlmResult, ResearchInput } from "./provider.js";

/**
 * Dispatches each call to the adapter for the model's provider, building adapters on first
 * use and rebuilding them when a key changes. When LLM_PROVIDER is "mock" every call goes to
 * the mock adapter regardless of the selected model, which is what tests and dry runs want.
 */
export class LlmRouter implements LlmProvider {
  readonly name = "router";
  private readonly adapters = new Map<string, { adapter: LlmAdapter; apiKey: string; baseUrl: string | null }>();
  private readonly mock: MockLlmAdapter;

  constructor(private readonly deps: LlmDeps) {
    this.mock = new MockLlmAdapter(deps);
  }

  private get forceMock(): boolean {
    return this.deps.config.LLM_PROVIDER === "mock";
  }

  /** Null when the provider has no usable key. */
  async adapterFor(provider: string): Promise<LlmAdapter | null> {
    if (this.forceMock || provider === "mock") return this.mock;
    const cred = await this.deps.credentials.resolve(provider as never);
    if (!cred) return null;
    const cached = this.adapters.get(provider);
    if (cached && cached.apiKey === cred.apiKey && cached.baseUrl === cred.baseUrl) return cached.adapter;
    let adapter: LlmAdapter;
    switch (provider) {
      case "anthropic":
        adapter = AnthropicAdapter.create(this.deps, cred.apiKey, cred.baseUrl);
        break;
      case "openai":
        adapter = OpenAiAdapter.create("openai", this.deps, cred.apiKey, cred.baseUrl);
        break;
      case "deepseek":
        adapter = OpenAiAdapter.create("deepseek", this.deps, cred.apiKey, cred.baseUrl ?? this.deps.config.DEEPSEEK_BASE_URL);
        break;
      case "gemini":
        adapter = GeminiAdapter.create(this.deps, cred.apiKey);
        break;
      default:
        return null;
    }
    this.adapters.set(provider, { adapter, apiKey: cred.apiKey, baseUrl: cred.baseUrl });
    return adapter;
  }

  /** Throws a clear, actionable error when the selected model's provider has no key. */
  private async require(provider: string, label: string): Promise<LlmAdapter> {
    const adapter = await this.adapterFor(provider);
    if (!adapter) {
      throw new AppError(
        "llm_provider_unconfigured",
        `No API key is configured for ${provider}, which ${label} needs. Add one under Settings → Model providers, or pick a different model.`,
        400,
      );
    }
    return adapter;
  }

  async research(input: ResearchInput): Promise<LlmResult<Persona>> {
    const adapter = await this.require(input.model.provider, input.model.label);
    return adapter.research(input);
  }

  async draft(input: DraftInput): Promise<LlmResult<DraftOutput>> {
    const adapter = await this.require(input.model.provider, input.model.label);
    return adapter.draft(input);
  }

  /** Drop cached adapters so the next call picks up a rotated key. */
  invalidate(): void {
    this.adapters.clear();
    this.deps.credentials.invalidate();
  }
}

export function createLlmProvider(
  config: AppConfig,
  logger: Logger,
  metrics: MetricsSink,
  db: Db,
  credentials?: ProviderCredentialStore,
): LlmRouter {
  const store = credentials ?? new ProviderCredentialStore(db, config, logger);
  const deps: LlmDeps = { config, logger, metrics, db, credentials: store };
  return new LlmRouter(deps);
}
