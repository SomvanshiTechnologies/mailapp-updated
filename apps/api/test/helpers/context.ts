import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import pino from "pino";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { loadConfig, setConfigForTests, type AppConfig } from "../../src/config.js";
import { createDb, type DbHandle } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { NoopMetrics } from "../../src/observability/metrics.js";
import { MemoryQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/modules/storage/storage.js";
import { SettingsService } from "../../src/modules/settings/service.js";
import { AuthService } from "../../src/modules/auth/service.js";
import { JwtService } from "../../src/modules/auth/jwt.js";
import { AuditService } from "../../src/modules/audit/service.js";
import { MockLlmProvider } from "../../src/modules/llm/mock.js";
import { MockSesGateway } from "../../src/modules/ses/mock.js";
import type { AppContext } from "../../src/context.js";
import { buildApp } from "../../src/app.js";
import { registerJobHandlers } from "../../src/jobs/register.js";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../../src/modules/auth/plugin.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://mailapp:mailapp@localhost:5433/mailapp_test";

export interface TestContext extends AppContext {
  queue: MemoryQueue;
  ses: MockSesGateway;
  metrics: NoopMetrics;
  app: FastifyInstance;
  /** Truncate every application table. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

let migrated = false;

export function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: "test-jwt-secret-0123456789abcdef0123456789abcdef",
    APP_SECRET: "test-app-secret-0123456789abcdef0123456789abcdef",
    PUBLIC_BASE_URL: "http://localhost:4000",
    LLM_PROVIDER: "mock",
    SES_MODE: "mock",
    SES_FROM_EMAIL: "outreach@example.com",
    SES_FROM_NAME: "Outreach Team",
    SES_CONFIGURATION_SET: "test-config-set",
    SES_DAILY_CAP: "1000",
    SNS_VERIFY_SIGNATURES: "false",
    WEBSITE_FETCH_ENABLED: "false",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: path.join(os.tmpdir(), `mailapp-test-storage-${process.pid}`),
    ...overrides,
  });
}

export async function createTestContext(overrides: Partial<Record<string, string>> = {}): Promise<TestContext> {
  const config = testConfig(overrides);
  setConfigForTests(config);
  if (!migrated) {
    await runMigrations(config.DATABASE_URL);
    migrated = true;
  }
  const logger = pino({ level: "silent" });
  const dbHandle: DbHandle = createDb(config.DATABASE_URL, { max: 5 });
  const metrics = new NoopMetrics();
  const queue = new MemoryQueue(false);
  await fs.mkdir(config.STORAGE_LOCAL_DIR, { recursive: true });
  const storage = new LocalStorage(config.STORAGE_LOCAL_DIR);
  const settings = new SettingsService(dbHandle.db, config);
  const auth = new AuthService(dbHandle.db, new JwtService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_MINUTES), config.REFRESH_TOKEN_TTL_DAYS, config.APP_SECRET);
  const audit = new AuditService(dbHandle.db, logger);
  const llm = new MockLlmProvider({ config, logger, metrics, db: dbHandle.db });
  const ses = new MockSesGateway(config);
  const base: AppContext = { config, db: dbHandle.db, dbHandle, logger, metrics, queue, storage, settings, auth, audit, llm, ses, role: "test" };
  const app = await buildApp(base);
  await registerJobHandlers(base);
  const ctx: TestContext = {
    ...base,
    queue,
    ses,
    metrics,
    app,
    reset: async () => {
      await dbHandle.pool.query(`
        truncate table
          llm_calls, email_events, send_attempts, inbound_messages, emails, leads, campaign_access, campaigns, files,
          suppressions, instruction_docs, services, audit_logs, refresh_tokens, settings, users,
          ses_snapshots, daily_send_counters, imap_cursors
        restart identity cascade`);
      settings.invalidate();
      queue.published.length = 0;
      queue.failures.length = 0;
      ses.sent.length = 0;
    },
    close: async () => {
      await app.close();
      await dbHandle.close();
      setConfigForTests(null);
    },
  };
  return ctx;
}

export interface Session {
  cookies: string;
  user: { id: string; email: string; role: string };
}

/** Create a user with the given role and log in; returns a cookie header. */
export async function loginAs(ctx: TestContext, role: "admin" | "operator" | "viewer" = "admin", email = `${role}@test.local`): Promise<Session> {
  const password = "Password-12345!";
  const user = await ctx.auth.createUser({ email, name: role, password, role });
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return { cookies: cookieHeader(res), user: { id: user.id, email: user.email, role: user.role } };
}

export function cookieHeader(res: LightMyRequestResponse): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((c) => c.split(";")[0])
    .filter((c) => c.startsWith(ACCESS_COOKIE) || c.startsWith(REFRESH_COOKIE))
    .join("; ");
}

/** Authenticated request helper with CSRF header. */
export function req(ctx: TestContext, session: Session | null, opts: InjectOptions): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };
  if (session) headers.cookie = session.cookies;
  if (opts.method && opts.method !== "GET") headers["x-requested-with"] = "mailapp";
  return ctx.app.inject({ ...opts, headers });
}

export function json<T = any>(res: LightMyRequestResponse): T {
  return JSON.parse(res.body) as T;
}
