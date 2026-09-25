import type { AppConfig } from "./config.js";
import type { Db, DbHandle } from "./db/client.js";
import type { Logger } from "./observability/logger.js";
import type { MetricsSink } from "./observability/metrics.js";
import type { JobQueue } from "./jobs/queue.js";
import type { Storage } from "./modules/storage/storage.js";
import type { SettingsService } from "./modules/settings/service.js";
import type { AuthService } from "./modules/auth/service.js";
import type { AuditService } from "./modules/audit/service.js";
import type { LlmProvider } from "./modules/llm/provider.js";
import type { SesGateway } from "./modules/ses/gateway.js";

/** Everything a route or job handler needs. Built once per process in bootstrap.ts. */
export interface AppContext {
  config: AppConfig;
  db: Db;
  dbHandle: DbHandle;
  logger: Logger;
  metrics: MetricsSink;
  queue: JobQueue;
  storage: Storage;
  settings: SettingsService;
  auth: AuthService;
  audit: AuditService;
  llm: LlmProvider;
  ses: SesGateway;
  /** Process role, for status reporting. */
  role: "api" | "worker" | "test";
}
