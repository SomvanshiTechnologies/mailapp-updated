import { getConfig, type AppConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { getLogger, type Logger } from "./observability/logger.js";
import { Metrics, NoopMetrics, type MetricsSink } from "./observability/metrics.js";
import { PgBossQueue, type JobQueue } from "./jobs/queue.js";
import { createStorage } from "./modules/storage/storage.js";
import { SettingsService } from "./modules/settings/service.js";
import { AuthService } from "./modules/auth/service.js";
import { JwtService } from "./modules/auth/jwt.js";
import { AuditService } from "./modules/audit/service.js";
import { ProviderCredentialStore } from "./modules/llm/credentials.js";
import { createLlmProvider } from "./modules/llm/router.js";
import { createSesGateway } from "./modules/ses/gateway.js";
import type { AppContext } from "./context.js";

export interface BootstrapOptions {
  role: AppContext["role"];
  config?: AppConfig;
  logger?: Logger;
  queue?: JobQueue;
  metrics?: MetricsSink;
}

export async function bootstrap(opts: BootstrapOptions): Promise<AppContext & { shutdown(): Promise<void> }> {
  const config = opts.config ?? getConfig();
  const logger = (opts.logger ?? getLogger()).child({ role: opts.role });
  const dbHandle = createDb(config.DATABASE_URL, { max: opts.role === "worker" ? 8 : 10 });
  const metrics =
    opts.metrics ??
    (config.CLOUDWATCH_METRICS_ENABLED
      ? new Metrics({
          enabled: true,
          namespace: config.CLOUDWATCH_NAMESPACE,
          region: config.AWS_REGION,
          service: opts.role,
          logger,
        })
      : new NoopMetrics());
  const queue = opts.queue ?? new PgBossQueue(config.DATABASE_URL, logger.child({ component: "queue" }));
  const storage = createStorage(config);
  const settings = new SettingsService(dbHandle.db, config);
  const auth = new AuthService(
    dbHandle.db,
    new JwtService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_MINUTES),
    config.REFRESH_TOKEN_TTL_DAYS,
    config.APP_SECRET,
  );
  const audit = new AuditService(dbHandle.db, logger.child({ component: "audit" }));
  const credentials = new ProviderCredentialStore(dbHandle.db, config, logger.child({ component: "llm" }));
  const llm = createLlmProvider(config, logger.child({ component: "llm" }), metrics, dbHandle.db, credentials);
  const ses = createSesGateway(config, logger.child({ component: "ses" }));

  const ctx: AppContext = {
    config,
    db: dbHandle.db,
    dbHandle,
    logger,
    metrics,
    queue,
    storage,
    settings,
    auth,
    audit,
    llm,
    credentials,
    ses,
    role: opts.role,
  };

  return {
    ...ctx,
    shutdown: async () => {
      await queue.stop().catch((err) => logger.warn({ err }, "queue stop failed"));
      if (metrics instanceof Metrics) await metrics.stop();
      await dbHandle.close();
    },
  };
}
