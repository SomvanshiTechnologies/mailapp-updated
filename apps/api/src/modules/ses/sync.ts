import { desc, eq } from "drizzle-orm";
import type { AppContext } from "../../context.js";
import { sesSnapshots } from "../../db/schema.js";
import { addSuppression } from "../suppressions/service.js";

/**
 * Periodic pull of SES account state + CloudWatch metrics into the DB, and reconciliation of
 * the SES account-level suppression list into our own.
 */
export async function runSesSync(ctx: AppContext): Promise<void> {
  const log = ctx.logger.child({ job: "ses.sync" });
  const settings = await ctx.settings.get();

  const account = await ctx.ses.getAccount();
  await ctx.db.insert(sesSnapshots).values({ kind: "account", data: account as unknown as Record<string, unknown> });
  if (account.error) log.warn({ error: account.error }, "GetAccount failed");
  if (account.enforcementStatus && account.enforcementStatus !== "HEALTHY") {
    log.error({ enforcementStatus: account.enforcementStatus }, "SES account enforcement status is not healthy");
  }

  const configSet = settings.configurationSet || ctx.config.SES_CONFIGURATION_SET || null;
  const metrics = await ctx.ses.getMetrics(configSet, 24);
  await ctx.db.insert(sesSnapshots).values({ kind: "metrics", data: metrics as unknown as Record<string, unknown> });

  // Suppression list reconciliation (last 2 days to overlap runs).
  if (ctx.ses.mode === "ses") {
    try {
      const [last] = await ctx.db.select().from(sesSnapshots).where(eq(sesSnapshots.kind, "suppression_sync")).orderBy(desc(sesSnapshots.fetchedAt)).limit(1);
      const since = last ? new Date(last.fetchedAt.getTime() - 86_400_000) : new Date(Date.now() - 30 * 86_400_000);
      const list = await ctx.ses.listSuppressed(since);
      let added = 0;
      for (const s of list) {
        const before = await addSuppression(ctx, { email: s.email, reason: "ses_account_list", source: "ses_sync", note: s.reason });
        if (before.source === "ses_sync" && Date.now() - before.createdAt.getTime() < 60_000) added++;
      }
      await ctx.db.insert(sesSnapshots).values({ kind: "suppression_sync", data: { count: list.length, added, since: since.toISOString() } });
      log.info({ count: list.length, added }, "suppression list synced");
    } catch (err) {
      log.warn({ err }, "suppression sync failed");
    }
  }

  const stats = await ctx.queue.stats();
  for (const q of stats) ctx.metrics.emit("queue_depth", q.created + q.retry, { queue: q.queue });
  log.info({ sendingEnabled: account.sendingEnabled, quota: account.sendQuota }, "ses sync complete");
}
