import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import type { SystemStatus } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { dailySendCounters, imapCursors, sesSnapshots } from "../../db/schema.js";
import { utcDay } from "../../lib/time.js";
import { z } from "zod";
import { parse } from "../../lib/validate.js";
import { listImapAccounts } from "../ses/imap.js";

export async function systemRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/system/status", { preHandler: app.authenticate }, async () => {
    let db: "ok" | "error" = "ok";
    try {
      await ctx.dbHandle.pool.query("select 1");
    } catch {
      db = "error";
    }
    const queues = await ctx.queue.stats();
    const [snap] = await ctx.db
      .select()
      .from(sesSnapshots)
      .where(eq(sesSnapshots.kind, "account"))
      .orderBy(desc(sesSnapshots.fetchedAt))
      .limit(1);
    const [counter] = await ctx.db.select().from(dailySendCounters).where(eq(dailySendCounters.day, utcDay()));
    const settings = await ctx.settings.get();
    const accounts = await listImapAccounts(ctx);
    const cursors = await ctx.db.select().from(imapCursors);
    const cursorByKey = new Map(cursors.map((c) => [c.accountKey, c]));
    const status: SystemStatus = {
      replyCapture: {
        inboundDomain: ctx.config.SES_INBOUND_DOMAIN || null,
        imapAccounts: accounts.map((a) => ({
          key: a.key,
          label: a.label,
          enabled: true,
          lastPolledAt: cursorByKey.get(a.key)?.lastPolledAt?.toISOString() ?? null,
          lastError: cursorByKey.get(a.key)?.lastError ?? null,
        })),
      },
      now: new Date().toISOString(),
      version: ctx.config.APP_VERSION,
      env: ctx.config.NODE_ENV,
      llmProvider: ctx.config.LLM_PROVIDER,
      sesMode: ctx.config.SES_MODE,
      db,
      queue: (await ctx.queue.healthy()) ? "ok" : "error",
      queues,
      lastSesSyncAt: snap?.fetchedAt.toISOString() ?? null,
      sentToday: counter?.count ?? 0,
      dailyCap: settings.dailyCap,
    };
    return status;
  });

  app.get("/api/audit", { preHandler: app.requireRole("admin") }, async (req) => {
    const text = (max: number) =>
      z
        .string()
        .trim()
        .max(max)
        .optional()
        .transform((v) => v || undefined);
    const dateish = z
      .string()
      .trim()
      .optional()
      .transform((v) => v || undefined)
      .refine((v) => v === undefined || !Number.isNaN(new Date(v).getTime()), "invalid date");
    const q = parse(
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
        action: text(120),
        user: text(254),
        entityType: text(60),
        entityId: text(80),
        from: dateish,
        to: dateish,
        q: text(200),
      }),
      req.query,
    );
    return ctx.audit.list(q);
  });

  app.get("/api/audit/facets", { preHandler: app.requireRole("admin") }, async () => ctx.audit.facets());
}
