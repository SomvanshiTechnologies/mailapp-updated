import { eq } from "drizzle-orm";
import { CONFIGURABLE_PROVIDERS, PROVIDER_KEY_HINTS, PROVIDER_LABELS, type ConfigurableProvider, type LlmProviderName, type ProviderStatusDto } from "@mailapp/shared";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { providerCredentials } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import type { Logger } from "../../observability/logger.js";
import { modelCountByProvider } from "./catalogue.js";

export interface ResolvedCredential {
  apiKey: string;
  baseUrl: string | null;
  source: "database" | "environment";
}

/**
 * Where a provider's API key comes from. A key stored from the dashboard wins over the
 * environment, so an operator can rotate a key without a redeploy; the environment remains
 * the way to bootstrap a fresh install.
 *
 * Keys are cached for a few seconds because the worker resolves one on every job.
 */
export class ProviderCredentialStore {
  private cache: { at: number; rows: Map<ConfigurableProvider, { apiKey: string; baseUrl: string | null }> } | null = null;
  private static readonly TTL_MS = 10_000;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  private envKey(provider: ConfigurableProvider): string {
    switch (provider) {
      case "anthropic":
        return this.config.ANTHROPIC_API_KEY;
      case "openai":
        return this.config.OPENAI_API_KEY;
      case "gemini":
        return this.config.GEMINI_API_KEY;
      case "deepseek":
        return this.config.DEEPSEEK_API_KEY;
    }
  }

  private envBaseUrl(provider: ConfigurableProvider): string | null {
    if (provider === "openai") return this.config.OPENAI_BASE_URL || null;
    if (provider === "deepseek") return this.config.DEEPSEEK_BASE_URL || null;
    return null;
  }

  private async load(force = false): Promise<Map<ConfigurableProvider, { apiKey: string; baseUrl: string | null }>> {
    if (!force && this.cache && Date.now() - this.cache.at < ProviderCredentialStore.TTL_MS) return this.cache.rows;
    const rows = new Map<ConfigurableProvider, { apiKey: string; baseUrl: string | null }>();
    try {
      for (const row of await this.db.select().from(providerCredentials)) {
        if (!CONFIGURABLE_PROVIDERS.includes(row.provider as ConfigurableProvider)) continue;
        try {
          rows.set(row.provider as ConfigurableProvider, {
            apiKey: decryptSecret(this.config.APP_SECRET, row.apiKeyEnc),
            baseUrl: row.baseUrl || null,
          });
        } catch (err) {
          // A key encrypted under a different APP_SECRET is unusable; fall back to the env.
          this.logger.warn({ err, provider: row.provider }, "stored provider key could not be decrypted");
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "failed to read provider credentials");
    }
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  /** Null when neither the database nor the environment has a key for this provider. */
  async resolve(provider: LlmProviderName): Promise<ResolvedCredential | null> {
    if (provider === "mock") return { apiKey: "mock", baseUrl: null, source: "environment" };
    const p = provider as ConfigurableProvider;
    const stored = (await this.load()).get(p);
    if (stored?.apiKey) return { apiKey: stored.apiKey, baseUrl: stored.baseUrl ?? this.envBaseUrl(p), source: "database" };
    const env = this.envKey(p);
    if (env) return { apiKey: env, baseUrl: this.envBaseUrl(p), source: "environment" };
    return null;
  }

  /** Providers with a usable key right now. Used to grey out models in the picker. */
  async availableProviders(): Promise<Set<LlmProviderName>> {
    const out = new Set<LlmProviderName>(["mock"]);
    for (const p of CONFIGURABLE_PROVIDERS) {
      if (await this.resolve(p)) out.add(p);
    }
    return out;
  }

  async upsert(provider: ConfigurableProvider, apiKey: string, baseUrl: string | null, userId: string | null): Promise<void> {
    const value = {
      provider,
      apiKeyEnc: encryptSecret(this.config.APP_SECRET, apiKey),
      keyHint: apiKey.slice(-4),
      baseUrl: baseUrl || null,
      // A new key invalidates whatever the previous test said.
      lastTestOk: null,
      lastTestAt: null,
      lastTestMessage: null,
      updatedBy: userId,
      updatedAt: new Date(),
    };
    await this.db.insert(providerCredentials).values(value).onConflictDoUpdate({ target: providerCredentials.provider, set: value });
    this.cache = null;
  }

  async remove(provider: ConfigurableProvider): Promise<void> {
    await this.db.delete(providerCredentials).where(eq(providerCredentials.provider, provider));
    this.cache = null;
  }

  async recordTest(provider: ConfigurableProvider, ok: boolean, message: string | null): Promise<void> {
    await this.db
      .update(providerCredentials)
      .set({ lastTestOk: ok, lastTestAt: new Date(), lastTestMessage: message?.slice(0, 500) ?? null })
      .where(eq(providerCredentials.provider, provider));
  }

  /** One row per configurable provider for the Settings card. */
  async status(): Promise<ProviderStatusDto[]> {
    const rows = await this.db.select().from(providerCredentials);
    const byProvider = new Map(rows.map((r) => [r.provider as ConfigurableProvider, r]));
    const counts = modelCountByProvider();
    const out: ProviderStatusDto[] = [];
    for (const provider of CONFIGURABLE_PROVIDERS) {
      const resolved = await this.resolve(provider);
      const row = byProvider.get(provider);
      out.push({
        provider,
        label: PROVIDER_LABELS[provider],
        configured: resolved !== null,
        source: resolved?.source ?? "none",
        baseUrl: resolved?.baseUrl ?? null,
        envVar: PROVIDER_KEY_HINTS[provider].envVar,
        keysUrl: PROVIDER_KEY_HINTS[provider].url,
        keyHint: resolved?.source === "database" ? (row?.keyHint || null) : null,
        updatedAt: row?.updatedAt?.toISOString() ?? null,
        modelCount: counts[provider] ?? 0,
        lastTest:
          row?.lastTestAt && row.lastTestOk !== null
            ? { ok: row.lastTestOk, at: row.lastTestAt.toISOString(), message: row.lastTestMessage }
            : null,
      });
    }
    return out;
  }

  invalidate(): void {
    this.cache = null;
  }
}
