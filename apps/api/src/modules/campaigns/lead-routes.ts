import type { FastifyInstance } from "fastify";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { JOB_QUEUES, TERMINAL_LEAD_STATUSES, type LeadDetailDto, type LeadStatus, type ServiceRecommendation } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { emailEvents, emails, leads, sendAttempts } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { parse, requireUuid } from "../../lib/validate.js";
import { requireLeadAccess } from "../auth/access.js";
import { getLeadOrThrow, nextSendAtMap, toLeadDto } from "./service.js";
import { toEmailDto, toEventDto, toAttemptDto } from "../emails/dto.js";
import { unsubscribeLead } from "../suppressions/service.js";
import type { DraftJob, QualifyJob, ResearchJob } from "../../jobs/types.js";
import { listActiveServices } from "../services/routes.js";
import { applyQualification } from "../pipeline/qualify.js";
import { humanQualification } from "../pipeline/qualification.js";

/** Statuses in which a qualification decision can still be made or changed (nothing drafted yet). */
const DECIDABLE_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>(["researched", "qualified", "unqualified", "on_hold"]);

const QualificationDecisionSchema = z.object({
  decision: z.enum(["qualify", "disqualify"]),
  /** Omit to keep the recommended service; null to qualify without one. */
  serviceId: z.string().uuid().nullable().optional(),
  note: z.string().max(1000).optional(),
});

export async function leadsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/leads/:id", { preHandler: app.authenticate }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { lead, campaign } = await requireLeadAccess(ctx, req, id, "view");
    const mails = await ctx.db.select().from(emails).where(eq(emails.leadId, id)).orderBy(asc(emails.createdAt));
    const events = await ctx.db.select().from(emailEvents).where(eq(emailEvents.leadId, id)).orderBy(desc(emailEvents.occurredAt));
    const attempts = mails.length
      ? await ctx.db.select().from(sendAttempts).where(inArray(sendAttempts.emailId, mails.map((m) => m.id))).orderBy(desc(sendAttempts.createdAt))
      : [];
    const rules = await ctx.settings.effectiveHardRules(campaign.hardRulesOverride);
    const nextSend = await nextSendAtMap(ctx, [id], rules);
    const detail: LeadDetailDto = {
      ...toLeadDto(lead, nextSend.get(id) ?? null),
      emails: mails.map(toEmailDto),
      events: events.map(toEventDto),
      attempts: attempts.map(toAttemptDto),
    };
    return { lead: detail };
  });

  app.post("/api/leads/:id/retry", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { lead } = await requireLeadAccess(ctx, req, id, "edit");
    if (lead.status !== "failed" && lead.status !== "pending" && lead.status !== "rejected") {
      throw AppError.conflict(`Lead is ${lead.status}; only failed, rejected or pending leads can be retried`);
    }
    const nextStep = Math.max(1, lead.currentStep + (lead.sentAt ? 1 : 0));
    const needsQualification = ctx.config.QUALIFICATION_ENABLED && !lead.sentAt && lead.qualificationStatus !== "qualified";
    if (lead.persona && needsQualification) {
      await ctx.db.update(leads).set({ status: "researched", lastError: null, updatedAt: new Date() }).where(eq(leads.id, id));
      await ctx.queue.publish<QualifyJob>(JOB_QUEUES.qualify, { leadId: id }, { singletonKey: `qualify:${id}:${Date.now()}` });
    } else if (lead.persona) {
      await ctx.db.update(leads).set({ status: "researched", lastError: null, updatedAt: new Date() }).where(eq(leads.id, id));
      await ctx.queue.publish<DraftJob>(JOB_QUEUES.draft, { leadId: id, step: nextStep }, { singletonKey: `draft:${id}:${nextStep}:${Date.now()}` });
    } else {
      await ctx.db.update(leads).set({ status: "pending", lastError: null, updatedAt: new Date() }).where(eq(leads.id, id));
      await ctx.queue.publish<ResearchJob>(JOB_QUEUES.research, { leadId: id }, { singletonKey: `research:${id}:${Date.now()}` });
    }
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "lead.retry", entityType: "lead", entityId: id, ip: req.ip });
    return { lead: toLeadDto(await getLeadOrThrow(ctx, id)) };
  });

  app.post("/api/leads/:id/research", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { lead } = await requireLeadAccess(ctx, req, id, "edit");
    // Unqualified leads may be re-researched: new evidence can change the decision.
    if (TERMINAL_LEAD_STATUSES.has(lead.status) && lead.status !== "unqualified") throw AppError.conflict(`Lead is ${lead.status}`);
    await ctx.db.update(leads).set({ status: "pending", lastError: null, updatedAt: new Date() }).where(eq(leads.id, id));
    await ctx.queue.publish<ResearchJob>(JOB_QUEUES.research, { leadId: id }, { singletonKey: `research:${id}:${Date.now()}` });
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "lead.research", entityType: "lead", entityId: id, ip: req.ip });
    return { lead: toLeadDto(await getLeadOrThrow(ctx, id)) };
  });

  // Run qualification again on the current research (e.g. after editing targeting criteria).
  app.post("/api/leads/:id/qualify", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { lead } = await requireLeadAccess(ctx, req, id, "edit");
    if (!DECIDABLE_STATUSES.has(lead.status)) throw AppError.conflict(`Lead is ${lead.status}; it can only be re-qualified before drafting`);
    if (!lead.persona) throw AppError.conflict("Lead has no research yet");
    await ctx.db.update(leads).set({ status: "researched", lastError: null, updatedAt: new Date() }).where(eq(leads.id, id));
    await ctx.queue.publish<QualifyJob>(JOB_QUEUES.qualify, { leadId: id }, { singletonKey: `qualify:${id}:${Date.now()}` });
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "lead.qualify", entityType: "lead", entityId: id, ip: req.ip });
    return { lead: toLeadDto(await getLeadOrThrow(ctx, id)) };
  });

  // A person decides: qualify (optionally choosing the service) or disqualify.
  app.post("/api/leads/:id/qualification", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { lead, campaign } = await requireLeadAccess(ctx, req, id, "edit");
    const body = parse(QualificationDecisionSchema, req.body);
    if (!DECIDABLE_STATUSES.has(lead.status)) throw AppError.conflict(`Lead is ${lead.status}; the decision can only be changed before drafting`);
    if (body.decision === "qualify" && !lead.persona) throw AppError.conflict("Lead has no research yet");

    let service: ServiceRecommendation | null = null;
    if (body.decision === "qualify") {
      const catalogue = await listActiveServices(ctx, campaign.serviceIds ?? []);
      const previous = lead.qualification?.service ?? null;
      const chosenId = body.serviceId === undefined ? previous?.serviceId ?? null : body.serviceId;
      if (chosenId) {
        const s = catalogue.find((x) => x.id === chosenId);
        if (!s) throw AppError.badRequest("That service is not active in this campaign");
        service =
          previous?.serviceId === s.id
            ? previous
            : { serviceId: s.id, serviceName: s.name, fitScore: 0, rationale: "Chosen by an operator.", supportingEvidence: [] };
      }
    }
    const result = humanQualification(lead.qualification ?? null, {
      outcome: body.decision === "qualify" ? "qualified" : "unqualified",
      service,
      note: body.note ?? "",
      userEmail: req.user!.email,
    });
    await applyQualification(ctx, lead, result);
    await ctx.audit.log({
      userId: req.user!.sub,
      userEmail: req.user!.email,
      action: `lead.${body.decision}`,
      entityType: "lead",
      entityId: id,
      metadata: { serviceId: service?.serviceId ?? null, note: body.note ?? null },
      ip: req.ip,
    });
    return { lead: toLeadDto(await getLeadOrThrow(ctx, id)) };
  });

  app.post("/api/leads/:id/skip", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { lead } = await requireLeadAccess(ctx, req, id, "edit");
    if (TERMINAL_LEAD_STATUSES.has(lead.status)) throw AppError.conflict(`Lead is already ${lead.status}`);
    const [row] = await ctx.db.update(leads).set({ status: "skipped", nextActionAt: null, updatedAt: new Date() }).where(eq(leads.id, id)).returning();
    await ctx.db.update(emails).set({ status: "rejected", updatedAt: new Date() }).where(inArray(emails.id, (await ctx.db.select({ id: emails.id }).from(emails).where(eq(emails.leadId, id))).map((e) => e.id)));
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "lead.skip", entityType: "lead", entityId: id, ip: req.ip });
    return { lead: toLeadDto(row) };
  });

  app.post("/api/leads/:id/mark-replied", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const body = parse(z.object({ note: z.string().max(2000).optional() }), req.body ?? {});
    await requireLeadAccess(ctx, req, id, "edit");
    const [row] = await ctx.db
      .update(leads)
      .set({ status: "replied", repliedAt: new Date(), nextActionAt: null, updatedAt: new Date() })
      .where(eq(leads.id, id))
      .returning();
    ctx.metrics.emit("replies", 1, { source: "manual" });
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "lead.mark_replied", entityType: "lead", entityId: id, metadata: { note: body.note }, ip: req.ip });
    return { lead: toLeadDto(row) };
  });

  app.post("/api/leads/:id/unsubscribe", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { lead } = await requireLeadAccess(ctx, req, id, "edit");
    await unsubscribeLead(ctx, lead, "manual", req.user!.sub);
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "lead.unsubscribe", entityType: "lead", entityId: id, ip: req.ip });
    return { lead: toLeadDto(await getLeadOrThrow(ctx, id)) };
  });
}
