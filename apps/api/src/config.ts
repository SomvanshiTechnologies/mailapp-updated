import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load .env from the process cwd first, then fall back to the repository root so
// `npm run -w apps/api ...` and Docker both find the same file.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.resolve(here, "../../../.env") });

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:4000"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(14),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(12).optional(),

  /**
   * "mock" forces the offline provider for every call regardless of the selected model.
   * "live" honours the model chosen in settings, so a campaign can use any provider whose
   * key is configured. "anthropic" is the historical value and behaves like "live".
   */
  LLM_PROVIDER: z.enum(["live", "anthropic", "mock"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),
  DEEPSEEK_API_KEY: z.string().optional().default(""),
  /** Optional base-URL overrides, for gateways or self-hosted compatible endpoints. */
  OPENAI_BASE_URL: z.string().optional().default(""),
  DEEPSEEK_BASE_URL: z.string().optional().default("https://api.deepseek.com"),
  LLM_MODEL: z.string().default("anthropic:claude-opus-5-5"),
  LLM_RESEARCH_MODEL: z.string().default("anthropic:claude-opus-5-5"),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(3),
  LLM_WEB_SEARCH: bool.default("true"),
  /** How many provider batches the tick submits or polls per run. */
  LLM_BATCH_MAX_PER_TICK: z.coerce.number().int().min(1).max(100).default(5),
  /** Give up polling a batch after this many attempts (1/min) and mark it failed. */
  LLM_BATCH_MAX_POLL_ATTEMPTS: z.coerce.number().int().min(10).max(10_000).default(1500),
  /** Fetch the lead website before research (disabled in tests). */
  WEBSITE_FETCH_ENABLED: bool.default("true"),

  AWS_REGION: z.string().default("us-east-1"),
  SES_MODE: z.enum(["ses", "mock"]).default("mock"),
  SES_CONFIGURATION_SET: z.string().optional().default(""),
  SES_FROM_EMAIL: z.string().email().default("outreach@example.com"),
  SES_FROM_NAME: z.string().default("Outreach Team"),
  SES_REPLY_TO: z.string().optional().default(""),
  SES_DAILY_CAP: z.coerce.number().int().min(0).default(2000),
  SES_MAX_SEND_RATE: z.coerce.number().min(0.1).default(5),
  SES_INBOUND_BUCKET: z.string().optional().default(""),
  SES_INBOUND_PREFIX: z.string().optional().default("inbound/"),
  /** Domain whose MX points at SES inbound; Reply-To addresses are generated on it. Empty = not configured. */
  SES_INBOUND_DOMAIN: z.string().optional().default(""),
  SNS_ALLOWED_TOPIC_ARNS: z.string().optional().default(""),
  /** Only ever false in tests; forced true in production. */
  SNS_VERIFY_SIGNATURES: bool.default("true"),

  /** Optional organisation-wide mailbox to poll (users can also configure their own in the app). */
  IMAP_ENABLED: bool.default("false"),
  IMAP_HOST: z.string().optional().default(""),
  IMAP_PORT: z.coerce.number().int().default(993),
  IMAP_USER: z.string().optional().default(""),
  IMAP_PASSWORD: z.string().optional().default(""),
  IMAP_MAILBOX: z.string().default("INBOX"),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  STORAGE_S3_BUCKET: z.string().optional().default(""),
  STORAGE_S3_PREFIX: z.string().optional().default("mailapp/"),

  CLOUDWATCH_METRICS_ENABLED: bool.default("false"),
  CLOUDWATCH_NAMESPACE: z.string().default("MailApp"),
  CLOUDWATCH_SES_METRICS_ENABLED: bool.default("false"),

  WORKER_RESEARCH_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  WORKER_DRAFT_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  WORKER_SEND_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),

  APP_VERSION: z.string().default("1.0.0"),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  isProd: boolean;
  isTest: boolean;
  snsAllowedTopicArns: string[];
};

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production") {
    // A live deployment needs at least one provider key; which models are usable is then
    // decided per provider at call time (a dashboard-supplied key also counts, but that
    // cannot be checked here because the database is not open yet).
    if (c.LLM_PROVIDER !== "mock" && !c.ANTHROPIC_API_KEY && !c.OPENAI_API_KEY && !c.GEMINI_API_KEY && !c.DEEPSEEK_API_KEY) {
      throw new Error("At least one model provider API key is required when LLM_PROVIDER is not 'mock'");
    }
    if (c.JWT_SECRET.startsWith("change-me") || c.APP_SECRET.startsWith("change-me")) {
      throw new Error("JWT_SECRET / APP_SECRET must be changed from the example values in production");
    }
  }
  if (c.NODE_ENV === "production") c.SNS_VERIFY_SIGNATURES = true;
  return {
    ...c,
    isProd: c.NODE_ENV === "production",
    isTest: c.NODE_ENV === "test",
    snsAllowedTopicArns: c.SNS_ALLOWED_TOPIC_ARNS.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: replace the cached config. */
export function setConfigForTests(cfg: AppConfig | null): void {
  cached = cfg;
}
