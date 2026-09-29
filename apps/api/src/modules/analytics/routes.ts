import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { DateRangeQuerySchema, SES_EVENT_TYPES } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { emailEvents, sesSnapshots } from "../../db/schema.js";
import { parse } from "../../lib/validate.js";
import { principalOf, requireCampaignAccess, visibleCampaignIds } from "../auth/access.js";
import { toEventDto } from "../emails/dto.js";
import { overview, timeseries, type RangeOpts } from "./service.js";
import { llmUsageDto } from "./cost.js";

export async function analyticsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * Range + scope for the caller: admins and users with dashboard scope "all" see everything;
   * everyone else only the campaigns they own or were granted. A specific campaignId must be
   * visible to the caller.
   */
  const scoped = async (req: FastifyRequest): Promise<RangeOpts> => {
    const q = parse(DateRangeQuerySchema, req.query);
    if (q.campaignId) await requireCampaignAccess(ctx, req, q.campaignId, "view");
    const visible = await visibleCampaignIds(ctx, principalOf(req), { forDashboard: true });
    return { from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined, campaignId: q.campaignId, campaignIds: visible ?? undefined };
  };

  app.get("/api/analytics/overview", { preHandler: app.authenticate }, async (req) => overview(ctx, await scoped(req)));

  app.get("/api/analytics/timeseries", { preHandler: app.authenticate }, async (req) => ({ points: await timeseries(ctx, await scoped(req)) }));

  app.get("/api/analytics/llm-usage", { preHandler: app.authenticate }, async (req) => {
    const o = await scoped(req);
    const to = o.to ?? new Date();
    const from = o.from ?? new Date(to.getTime() - 30 * 86_400_000);
    return llmUsageDto(ctx, { from, to, campaignId: o.campaignId, campaignIds: o.campaignIds });
  });

  app.get("/api/analytics/events", { preHandler: app.authenticate }, async (req) => {
    const q = parse(
      z.object({
        campaignId: z.string().uuid().optional(),
        type: z.enum(SES_EVENT_TYPES).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const conds = [];
    if (q.campaignId) {
      await requireCampaignAccess(ctx, req, q.campaignId, "view");
      conds.push(eq(emailEvents.campaignId, q.campaignId));
    } else {
      const visible = await visibleCampaignIds(ctx, principalOf(req), { forDashboard: true });
      if (visible !== null) {
        if (!visible.length) return { items: [], page: q.page, pageSize: q.pageSize, total: 0 };
        conds.push(inArray(emailEvents.campaignId, visible));
      }
    }
    if (q.type) conds.push(eq(emailEvents.eventType, q.type));
    const where = conds.length ? and(...conds) : undefined;
    const [{ count }] = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(emailEvents).where(where);
    const rows = await ctx.db.select().from(emailEvents).where(where).orderBy(desc(emailEvents.occurredAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items: rows.map(toEventDto), page: q.page, pageSize: q.pageSize, total: count };
  });

  app.get("/api/analytics/ses-account", { preHandler: app.authenticate }, async () => {
    const live = await ctx.ses.getAccount();
    if (!live.error) return live;
    const [snap] = await ctx.db.select().from(sesSnapshots).where(eq(sesSnapshots.kind, "account")).orderBy(desc(sesSnapshots.fetchedAt)).limit(1);
    return snap ? { ...(snap.data as object), error: `live fetch failed (${live.error}); showing snapshot from ${snap.fetchedAt.toISOString()}` } : live;
  });

  app.get("/api/analytics/ses-metrics", { preHandler: app.authenticate }, async (req) => {
    const q = parse(z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) }), req.query);
    const settings = await ctx.settings.get();
    return ctx.ses.getMetrics(settings.configurationSet || ctx.config.SES_CONFIGURATION_SET || null, q.hours);
  });
}
