import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CAMPAIGN_STATUSES,
  CreateCampaignSchema,
  GrantCampaignAccessSchema,
  LeadListQuerySchema,
  UpdateCampaignSchema,
  JOB_QUEUES,
  type CampaignAccessDto,
  type CampaignAccessLevel,
} from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaignAccess, campaigns, emails, leads, users, type CampaignRow } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { parse, requireUuid } from "../../lib/validate.js";
import { readUploadedFile } from "../../lib/upload.js";
import { campaignAccessFor, campaignAccessMap, principalOf, requireCampaignAccess, visibleCampaignIds } from "../auth/access.js";
import {
  campaignCounts,
  campaignCountsMap,
  createCampaignFromSheet,
  nextSendAtMap,
  ownerNames,
  parseSheet,
  previewSheet,
  setCampaignStatus,
  startCampaign,
  toCampaignDto,
  toLeadDto,
} from "./service.js";
import { buildStatusWorkbook } from "../excel/export.js";
import { campaignTimeseries } from "../analytics/service.js";
import type { SendJob } from "../../jobs/types.js";

export async function campaignsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /** DTO for one campaign as seen by the caller (owner name + effective access). */
  const dtoFor = async (req: FastifyRequest, c: CampaignRow, access?: CampaignAccessLevel) => {
    const names = await ownerNames(ctx, [c]);
    const myAccess = access ?? ((await campaignAccessFor(ctx, principalOf(req), c)) as CampaignAccessLevel);
    return toCampaignDto(c, await campaignCounts(ctx, c.id), { createdByName: c.createdBy ? (names.get(c.createdBy) ?? null) : null, myAccess });
  };

  app.get("/api/campaigns", { preHandler: app.authenticate }, async (req) => {
    const q = parse(z.object({ status: z.enum(CAMPAIGN_STATUSES).optional() }), req.query);
    const who = principalOf(req);
    const visible = await visibleCampaignIds(ctx, who);
    const conds = [];
    if (q.status) conds.push(eq(campaigns.status, q.status));
    if (visible !== null) {
      if (!visible.length) return { items: [] };
      conds.push(inArray(campaigns.id, visible));
    }
    const rows = await ctx.db
      .select()
      .from(campaigns)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(campaigns.createdAt));
    const [counts, names, access] = await Promise.all([campaignCountsMap(ctx, rows.map((r) => r.id)), ownerNames(ctx, rows), campaignAccessMap(ctx, who, rows)]);
    return {
      items: rows.map((r) =>
        toCampaignDto(r, counts.get(r.id) ?? emptyCounts(), {
          createdByName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
          myAccess: (access.get(r.id) === "none" ? "view" : access.get(r.id)) as CampaignAccessLevel,
        }),
      ),
    };
  });

  app.post("/api/campaigns/preview", { preHandler: app.requireRole("operator") }, async (req) => {
    const file = await readUploadedFile(req, [".xlsx", ".csv"]);
    const sheet = await parseSheet(file.buffer, file.filename);
    return previewSheet(sheet);
  });

  app.post("/api/campaigns", { preHandler: app.requireRole("operator") }, async (req) => {
    const file = await readUploadedFile(req, [".xlsx", ".csv"]);
    let payloadRaw: unknown = {};
    if (file.fields.payload) {
      try {
        payloadRaw = JSON.parse(file.fields.payload);
      } catch {
        throw AppError.badRequest("payload must be a JSON string");
      }
    }
    const input = parse(CreateCampaignSchema, payloadRaw);
    const sheet = await parseSheet(file.buffer, file.filename);
    const campaign = await createCampaignFromSheet(ctx, { input, sheet, file, userId: req.user!.sub });
    await ctx.audit.log({
      userId: req.user!.sub,
      userEmail: req.user!.email,
      action: "campaign.create",
      entityType: "campaign",
      entityId: campaign.id,
      metadata: { name: campaign.name, file: file.filename, summary: campaign.importSummary },
      ip: req.ip,
    });
    return { campaign: await dtoFor(req, campaign, "full") };
  });

  app.get("/api/campaigns/:id", { preHandler: app.authenticate }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { campaign, access } = await requireCampaignAccess(ctx, req, id, "view");
    return { campaign: await dtoFor(req, campaign, access as CampaignAccessLevel) };
  });

  /** Campaign settings are editable only while the campaign is still a draft. */
  app.patch("/api/campaigns/:id", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const body = parse(UpdateCampaignSchema, req.body);
    const { campaign } = await requireCampaignAccess(ctx, req, id, "full");
    if (campaign.status !== "draft") throw AppError.conflict("Campaign settings are locked once the campaign has been started");
    const set: Partial<typeof campaigns.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) set.name = body.name;
    if (body.description !== undefined) set.description = body.description;
    if (body.approvalMode !== undefined) set.approvalMode = body.approvalMode;
    if (body.sequence !== undefined) set.sequence = body.sequence;
    if (body.serviceIds !== undefined) set.serviceIds = body.serviceIds;
    if (body.fromEmail !== undefined) set.fromEmail = body.fromEmail || null;
    if (body.fromName !== undefined) set.fromName = body.fromName || null;
    if (body.replyTo !== undefined) set.replyTo = body.replyTo || null;
    if (body.extraGuidance !== undefined) set.extraGuidance = body.extraGuidance;
    if (body.hardRulesOverride !== undefined) set.hardRulesOverride = body.hardRulesOverride ?? null;
    const [row] = await ctx.db.update(campaigns).set(set).where(eq(campaigns.id, id)).returning();
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "campaign.update", entityType: "campaign", entityId: id, metadata: { fields: Object.keys(body) }, ip: req.ip });
    return { campaign: await dtoFor(req, row, "full") };
  });

  const transition = (action: "start" | "pause" | "resume" | "archive") =>
    async (req: FastifyRequest) => {
      const id = requireUuid((req.params as { id: string }).id);
      await requireCampaignAccess(ctx, req, id, "full");
      let campaign;
      let enqueued = 0;
      if (action === "start" || action === "resume") {
        const r = await startCampaign(ctx, id);
        campaign = r.campaign;
        enqueued = r.enqueued;
      } else {
        campaign = await setCampaignStatus(ctx, id, action === "pause" ? "paused" : "archived");
      }
      await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: `campaign.${action}`, entityType: "campaign", entityId: id, metadata: { enqueued }, ip: req.ip });
      return { campaign: await dtoFor(req, campaign, "full"), enqueued };
    };
  app.post("/api/campaigns/:id/start", { preHandler: app.requireRole("operator") }, transition("start"));
  app.post("/api/campaigns/:id/resume", { preHandler: app.requireRole("operator") }, transition("resume"));
  app.post("/api/campaigns/:id/pause", { preHandler: app.requireRole("operator") }, transition("pause"));
  app.post("/api/campaigns/:id/archive", { preHandler: app.requireRole("operator") }, transition("archive"));

  app.delete("/api/campaigns/:id", { preHandler: app.requireRole("admin") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { campaign: c } = await requireCampaignAccess(ctx, req, id, "full");
    if (c.status !== "draft" && c.status !== "archived") throw AppError.conflict("Only draft or archived campaigns can be deleted");
    await ctx.db.delete(campaigns).where(eq(campaigns.id, id));
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "campaign.delete", entityType: "campaign", entityId: id, metadata: { name: c.name }, ip: req.ip });
    return { ok: true };
  });

  // ----- Access grants (admin) -----
  const listGrants = async (campaignId: string): Promise<CampaignAccessDto[]> => {
    const rows = await ctx.db
      .select({ userId: campaignAccess.userId, level: campaignAccess.level, grantedBy: campaignAccess.grantedBy, createdAt: campaignAccess.createdAt, name: users.name, email: users.email })
      .from(campaignAccess)
      .innerJoin(users, eq(users.id, campaignAccess.userId))
      .where(eq(campaignAccess.campaignId, campaignId))
      .orderBy(asc(users.name));
    return rows.map((r) => ({ userId: r.userId, userName: r.name, userEmail: r.email, level: r.level, grantedBy: r.grantedBy, createdAt: r.createdAt.toISOString() }));
  };

  app.get("/api/campaigns/:id/access", { preHandler: app.requireRole("admin") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    await requireCampaignAccess(ctx, req, id, "view");
    return { items: await listGrants(id) };
  });

  app.put("/api/campaigns/:id/access", { preHandler: app.requireRole("admin") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const body = parse(GrantCampaignAccessSchema, req.body);
    const { campaign } = await requireCampaignAccess(ctx, req, id, "view");
    const [target] = await ctx.db.select().from(users).where(eq(users.id, body.userId)).limit(1);
    if (!target) throw AppError.notFound("User");
    if (campaign.createdBy === target.id) throw AppError.conflict("The campaign owner already has full access");
    await ctx.db
      .insert(campaignAccess)
      .values({ campaignId: id, userId: body.userId, level: body.level, grantedBy: req.user!.sub })
      .onConflictDoUpdate({ target: [campaignAccess.campaignId, campaignAccess.userId], set: { level: body.level, grantedBy: req.user!.sub, createdAt: new Date() } });
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "campaign.grant_access", entityType: "campaign", entityId: id, metadata: { userId: body.userId, userEmail: target.email, level: body.level }, ip: req.ip });
    return { items: await listGrants(id) };
  });

  app.delete("/api/campaigns/:id/access/:userId", { preHandler: app.requireRole("admin") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const userId = requireUuid((req.params as { userId: string }).userId);
    await requireCampaignAccess(ctx, req, id, "view");
    await ctx.db.delete(campaignAccess).where(and(eq(campaignAccess.campaignId, id), eq(campaignAccess.userId, userId)));
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "campaign.revoke_access", entityType: "campaign", entityId: id, metadata: { userId }, ip: req.ip });
    return { items: await listGrants(id) };
  });

  app.get("/api/campaigns/:id/leads", { preHandler: app.authenticate }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { campaign } = await requireCampaignAccess(ctx, req, id, "view");
    const q = parse(LeadListQuerySchema, req.query);
    const conds = [eq(leads.campaignId, id)];
    if (q.status) conds.push(eq(leads.status, q.status));
    if (q.search) {
      const term = `%${q.search.replace(/[%_]/g, "")}%`;
      conds.push(or(ilike(leads.email, term), ilike(leads.company, term), ilike(leads.firstName, term), ilike(leads.lastName, term))!);
    }
    const where = and(...conds);
    const [{ count }] = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(leads).where(where);
    const rows = await ctx.db
      .select()
      .from(leads)
      .where(where)
      .orderBy(asc(leads.rowNumber))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const rules = await ctx.settings.effectiveHardRules(campaign.hardRulesOverride);
    const nextSend = await nextSendAtMap(ctx, rows.map((r) => r.id), rules);
    return { items: rows.map((l) => toLeadDto(l, nextSend.get(l.id) ?? null)), page: q.page, pageSize: q.pageSize, total: count };
  });

  app.get("/api/campaigns/:id/stats", { preHandler: app.authenticate }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    await requireCampaignAccess(ctx, req, id, "view");
    return { counts: await campaignCounts(ctx, id), timeseries: await campaignTimeseries(ctx, { campaignId: id }) };
  });

  app.get("/api/campaigns/:id/export", { preHandler: app.authenticate }, async (req, reply) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { campaign: c } = await requireCampaignAccess(ctx, req, id, "view");
    const rows = await ctx.db.select().from(leads).where(eq(leads.campaignId, id)).orderBy(asc(leads.rowNumber));
    const latest = new Map<string, typeof emails.$inferSelect>();
    const mails = await ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.campaignId, id), eq(emails.direction, "outbound")))
      .orderBy(desc(emails.createdAt));
    for (const m of mails) if (!latest.has(m.leadId)) latest.set(m.leadId, m);
    const buffer = await buildStatusWorkbook(c, rows, latest);
    const name = `${c.name.replace(/[^a-z0-9-_]+/gi, "_")}-status-${new Date().toISOString().slice(0, 10)}.xlsx`;
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "campaign.export", entityType: "campaign", entityId: id, metadata: { rows: rows.length }, ip: req.ip });
    return reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="${name}"`)
      .send(buffer);
  });

  app.post("/api/campaigns/:id/approve-all", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    await requireCampaignAccess(ctx, req, id, "edit");
    const pending = await ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.campaignId, id), eq(emails.status, "pending_review")));
    let approved = 0;
    for (const e of pending) {
      if (e.validation && !e.validation.ok) continue; // never bulk-approve drafts that failed validation
      await ctx.db
        .update(emails)
        .set({ status: "approved", reviewedBy: req.user!.sub, reviewedAt: new Date(), updatedAt: new Date() })
        .where(eq(emails.id, e.id));
      await ctx.db.update(leads).set({ status: "approved", updatedAt: new Date() }).where(and(eq(leads.id, e.leadId), inArray(leads.status, ["pending_review"])));
      await ctx.queue.publish<SendJob>(JOB_QUEUES.send, { emailId: e.id }, { singletonKey: `send:${e.id}` });
      approved++;
    }
    ctx.metrics.emit("drafts_approved", approved);
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "campaign.approve_all", entityType: "campaign", entityId: id, metadata: { approved, skipped: pending.length - approved }, ip: req.ip });
    return { approved };
  });
}

function emptyCounts() {
  return {
    total: 0, pending: 0, researching: 0, drafting: 0, pendingReview: 0, approved: 0, sent: 0, delivered: 0,
    opened: 0, clicked: 0, replied: 0, bounced: 0, complained: 0, unsubscribed: 0, failed: 0, other: 0,
  };
}
