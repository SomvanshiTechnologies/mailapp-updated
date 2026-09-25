import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { EMAIL_STATUSES, JOB_QUEUES, RegenerateEmailSchema, ReviewEmailSchema } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { emailEvents, emails, leads, sendAttempts } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { parse, requireUuid } from "../../lib/validate.js";
import { principalOf, requireCampaignAccess, requireEmailAccess, visibleCampaignIds } from "../auth/access.js";
import { toLeadDto } from "../campaigns/service.js";
import { validateDraft } from "../pipeline/validator.js";
import { renderEmail } from "../pipeline/render.js";
import { loadInstructionBundle } from "../instructions/service.js";
import { resolveSender } from "../settings/sender.js";
import type { DraftJob, SendJob } from "../../jobs/types.js";
import { toAttemptDto, toEmailDto, toEventDto } from "./dto.js";

export async function emailsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/emails", { preHandler: app.authenticate }, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(EMAIL_STATUSES).optional(),
        campaignId: z.string().uuid().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const conds = [eq(emails.direction, "outbound")];
    if (q.status) conds.push(eq(emails.status, q.status));
    if (q.campaignId) {
      await requireCampaignAccess(ctx, req, q.campaignId, "view");
      conds.push(eq(emails.campaignId, q.campaignId));
    } else {
      const visible = await visibleCampaignIds(ctx, principalOf(req));
      if (visible !== null) {
        if (!visible.length) return { items: [], page: q.page, pageSize: q.pageSize, total: 0 };
        conds.push(inArray(emails.campaignId, visible));
      }
    }
    const where = and(...conds);
    const [{ count }] = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(emails).where(where);
    const rows = await ctx.db
      .select({ email: emails, lead: leads })
      .from(emails)
      .innerJoin(leads, eq(emails.leadId, leads.id))
      .where(where)
      .orderBy(desc(emails.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return { items: rows.map((r) => ({ ...toEmailDto(r.email), lead: toLeadDto(r.lead) })), page: q.page, pageSize: q.pageSize, total: count };
  });

  app.get("/api/emails/:id", { preHandler: app.authenticate }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const { email } = await requireEmailAccess(ctx, req, id, "view");
    const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, email.leadId)).limit(1);
    const attempts = await ctx.db.select().from(sendAttempts).where(eq(sendAttempts.emailId, id)).orderBy(desc(sendAttempts.createdAt));
    const events = await ctx.db.select().from(emailEvents).where(eq(emailEvents.emailId, id)).orderBy(desc(emailEvents.occurredAt));
    return { email: toEmailDto(email), lead: toLeadDto(lead), attempts: attempts.map(toAttemptDto), events: events.map(toEventDto) };
  });

  app.post("/api/emails/:id/approve", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const body = parse(ReviewEmailSchema, req.body ?? {});
    const { email, campaign } = await requireEmailAccess(ctx, req, id, "edit");
    if (email.status !== "pending_review" && email.status !== "draft" && email.status !== "failed") {
      throw AppError.conflict(`Email is ${email.status}`);
    }
    const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, email.leadId)).limit(1);
    const rules = await ctx.settings.effectiveHardRules(campaign.hardRulesOverride);
    const subject = body.subject ?? email.subject;
    const bodyText = body.bodyText ?? email.bodyText;
    const validation = validateDraft(subject, bodyText, rules, { toEmail: lead.email });
    // Reviewers may override validator errors knowingly, except do-not-contact domains.
    if (validation.issues.some((i) => i.rule === "do_not_contact_domain")) {
      throw AppError.conflict("Recipient domain is on the do-not-contact list", validation);
    }
    const [row] = await ctx.db
      .update(emails)
      .set({
        subject,
        bodyText,
        validation,
        status: "approved",
        reviewedBy: req.user!.sub,
        reviewedAt: new Date(),
        reviewNote: body.note ?? null,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(emails.id, id))
      .returning();
    await ctx.db.update(leads).set({ status: "approved", lastError: null, updatedAt: new Date() }).where(eq(leads.id, email.leadId));
    await ctx.queue.publish<SendJob>(JOB_QUEUES.send, { emailId: id }, { singletonKey: `send:${id}` });
    ctx.metrics.emit("drafts_approved");
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "email.approve", entityType: "email", entityId: id, metadata: { edited: body.subject !== undefined || body.bodyText !== undefined, validationOk: validation.ok }, ip: req.ip });
    return { email: toEmailDto(row) };
  });

  app.post("/api/emails/:id/reject", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const body = parse(z.object({ note: z.string().max(2000).optional() }), req.body ?? {});
    const { email } = await requireEmailAccess(ctx, req, id, "edit");
    if (!["pending_review", "draft", "approved", "queued", "failed"].includes(email.status)) throw AppError.conflict(`Email is ${email.status}`);
    const [row] = await ctx.db
      .update(emails)
      .set({ status: "rejected", reviewedBy: req.user!.sub, reviewedAt: new Date(), reviewNote: body.note ?? null, updatedAt: new Date() })
      .where(eq(emails.id, id))
      .returning();
    await ctx.db.update(leads).set({ status: "rejected", nextActionAt: null, updatedAt: new Date() }).where(eq(leads.id, email.leadId));
    ctx.metrics.emit("drafts_rejected_by_reviewer");
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "email.reject", entityType: "email", entityId: id, metadata: { note: body.note }, ip: req.ip });
    return { email: toEmailDto(row) };
  });

  app.post("/api/emails/:id/regenerate", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const body = parse(RegenerateEmailSchema, req.body ?? {});
    const { email } = await requireEmailAccess(ctx, req, id, "edit");
    if (!["pending_review", "draft", "rejected", "failed", "approved"].includes(email.status)) throw AppError.conflict(`Email is ${email.status}`);
    await ctx.db.update(leads).set({ status: "researched", updatedAt: new Date() }).where(eq(leads.id, email.leadId));
    await ctx.queue.publish<DraftJob>(
      JOB_QUEUES.draft,
      { leadId: email.leadId, step: email.step, regenerate: { emailId: id, feedback: body.feedback ?? null } },
      { singletonKey: `draft:${email.leadId}:${email.step}:regen:${Date.now()}` },
    );
    const [row] = await ctx.db.update(emails).set({ status: "rejected", reviewNote: body.feedback ? `regenerate: ${body.feedback}` : "regenerate", reviewedBy: req.user!.sub, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(emails.id, id)).returning();
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "email.regenerate", entityType: "email", entityId: id, metadata: { feedback: body.feedback }, ip: req.ip });
    return { email: toEmailDto(row) };
  });

  /** Send the draft to a mailbox you own, rendered exactly as the real send would be. */
  app.post("/api/emails/:id/send-test", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const body = parse(z.object({ to: z.string().email() }), req.body);
    const { email, campaign } = await requireEmailAccess(ctx, req, id, "edit");
    const settings = await ctx.settings.get();
    const rules = await ctx.settings.effectiveHardRules(campaign.hardRulesOverride);
    const sender = await resolveSender(ctx, campaign);
    const bundle = await loadInstructionBundle(ctx.db, sender.ownerId);
    const rendered = renderEmail({
      bodyText: email.bodyText,
      signature: bundle.signature,
      senderName: sender.fromName,
      unsubscribeUrl: `${ctx.config.PUBLIC_BASE_URL}/u/test`,
      postalAddress: sender.postalAddress,
      includeUnsubscribeFooter: rules.requireUnsubscribeFooter,
      linkLabel: settings.landingPage.emailLinkLabel,
      deliveryMode: settings.deliveryMode,
      htmlPart: settings.trackOpens,
    });
    const result = await ctx.ses.send({
      from: sender.fromEmail,
      fromName: sender.fromName,
      to: body.to,
      replyTo: sender.replyTo || undefined,
      subject: `[TEST] ${email.subject}`,
      text: rendered.text,
      html: rendered.html,
      headers: rendered.headers,
      tags: { test: "true", email_id: id },
      configurationSet: settings.configurationSet || ctx.config.SES_CONFIGURATION_SET || undefined,
    });
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "email.send_test", entityType: "email", entityId: id, metadata: { to: body.to, messageId: result.messageId }, ip: req.ip });
    return { ok: true, messageId: result.messageId };
  });
}
