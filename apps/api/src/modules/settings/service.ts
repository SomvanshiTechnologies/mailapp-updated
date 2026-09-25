import { eq } from "drizzle-orm";
import { DEFAULT_SETTINGS, HardRulesSchema, SettingsSchema, type HardRules, type Settings, type SettingsDto } from "@mailapp/shared";
import type { Db } from "../../db/client.js";
import { settings as settingsTable } from "../../db/schema.js";
import type { AppConfig } from "../../config.js";

const KEY = "app";

/**
 * Global settings stored as a single JSON row, seeded from env defaults.
 * Cached in memory for 10s so the worker does not hit the DB on every job.
 */
export class SettingsService {
  private cache: { value: SettingsDto; at: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  envDefaults(): Settings {
    return {
      ...DEFAULT_SETTINGS,
      fromEmail: this.config.SES_FROM_EMAIL,
      fromName: this.config.SES_FROM_NAME,
      replyTo: this.config.SES_REPLY_TO,
      configurationSet: this.config.SES_CONFIGURATION_SET,
      dailyCap: this.config.SES_DAILY_CAP,
      maxSendRate: this.config.SES_MAX_SEND_RATE,
      llmModel: this.config.LLM_MODEL,
      researchModel: this.config.LLM_RESEARCH_MODEL,
      webSearchEnabled: this.config.LLM_WEB_SEARCH,
    };
  }

  async get(force = false): Promise<SettingsDto> {
    if (!force && this.cache && Date.now() - this.cache.at < 10_000) return this.cache.value;
    const [row] = await this.db.select().from(settingsTable).where(eq(settingsTable.key, KEY)).limit(1);
    const merged = SettingsSchema.parse({ ...this.envDefaults(), ...((row?.value as Partial<Settings>) ?? {}) });
    const value: SettingsDto = { ...merged, updatedAt: row?.updatedAt?.toISOString() ?? null };
    this.cache = { value, at: Date.now() };
    return value;
  }

  async update(input: Settings, userId: string | null): Promise<SettingsDto> {
    const value = SettingsSchema.parse(input);
    await this.db
      .insert(settingsTable)
      .values({ key: KEY, value, updatedBy: userId, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
    this.cache = null;
    return this.get(true);
  }

  /** Effective hard rules for a campaign = global rules + campaign override. */
  async effectiveHardRules(override: Partial<HardRules> | null | undefined): Promise<HardRules> {
    const s = await this.get();
    return HardRulesSchema.parse({ ...s.hardRules, ...(override ?? {}) });
  }

  invalidate(): void {
    this.cache = null;
  }
}
