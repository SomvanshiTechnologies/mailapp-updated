import { and, asc, eq } from "drizzle-orm";
import { JOB_QUEUES, TERMINAL_LEAD_STATUSES, type DraftOutput } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, emails, leads, type CampaignRow, type LeadRow } from "../../db/schema.js";
import type { DraftJob, SendJob } from "../../jobs/types.js";
import { loadInstructionBundle } from "../instructions/service.js";
import { listActiveServices } from "../services/routes.js";
import { resolveSender } from "../settings/sender.js";
import type { PreviousEmail } from "../llm/provider.js";
import { describeIssues, validateDraft } from "./validator.js";

/**
 * Draft one email for a lead at a given sequence step. Runs the validator; on failure the
 * model gets one more attempt with the validator's feedback. Drafts that still fail go to
 * the review queue flagged, regardless of approval mode.
 */
export async function runDraftJob(ctx: AppContext, job: DraftJob): Promise<void> {
  const log = ctx.logger.child({ job: "draft", leadId: job.leadId, step: job.step });
  const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, job.leadId)).limit(1);
  if (!lead) return log.warn("lead not found");
  if (TERMINAL_LEAD_STATUSES.has(lead.status)) return log.info({ status: lead.status }, "lead terminal, skipping");
  if (!lead.persona) return log.warn("lead has no persona; research first");
  const [campaign] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, lead.campaignId)).limit(1);
  if (!campaign || campaign.status !== "active") return log.info({ status: campaign?.status }, "campaign not active, skipping");

  const step = campaign.sequence.find((s) => s.step === job.step);
  if (!step) {
    log.warn("step not in sequence; marking completed");
    await ctx.db.update(leads).set({ status: "completed", nextActionAt: null, updatedAt: new Date() }).where(eq(leads.id, lead.id));
    return;
  }
  // Guard against duplicate drafts for the same step (job retries, double publishes).
  if (!job.regenerate) {
    const [existing] = await ctx.db
      .select({ id: emails.id, status: emails.status })
      .from(emails)
      .where(and(eq(emails.leadId, lead.id), eq(emails.step, job.step), eq(emails.direction, "outbound")))
      .limit(1);
    if (existing && existing.status !== "rejected" && existing.status !== "failed") {
      return log.info({ emailId: existing.id }, "draft already exists for step");
    }
  }

  await ctx.db.update(leads).set({ status: "drafting", lastError: null, updatedAt: new Date() }).where(eq(leads.id, lead.id));
  try {
    const settings = await ctx.settings.get();
    const hardRules = await ctx.settings.effectiveHardRules(campaign.hardRulesOverride);
    const sender = await resolveSender(ctx, campaign);
    const [bundle, services] = await Promise.all([loadInstructionBundle(ctx.db, sender.ownerId), listActiveServices(ctx, campaign.serviceIds ?? [])]);
    const previous = await previousEmails(ctx, lead.id);
    const senderName = sender.fromName;

    let feedback = job.regenerate?.feedback ?? null;
    let output: DraftOutput | null = null;
    let validation = null as ReturnType<typeof validateDraft> | null;
    let llmMeta: Record<string, unknown> = {};
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await ctx.llm.draft({
        lead,
        persona: lead.persona,
        services,
        instructions: bundle,
        hardRules,
        step,
        totalSteps: campaign.sequence.length,
        previousEmails: previous,
        campaignGuidance: campaign.extraGuidance,
        regenerationFeedback: feedback,
        senderName,
        model: settings.llmModel,
      });
      output = result.output;
      validation = validateDraft(output.subject, output.bodyText, hardRules, { toEmail: lead.email });
      llmMeta = {
        model: result.model,
        usage: result.usage,
        durationMs: result.durationMs,
        attempt,
        pitchAngle: output.pitchAngle,
        callToAction: output.callToAction,
        personalisationUsed: output.personalisationUsed,
        selfCheck: output.selfCheck,
        selectedServices: output.selectedServices,
        regenerationFeedback: feedback,
      };
      if (validation.ok) break;
      ctx.metrics.emit("drafts_rejected_by_validator");
      feedback = `The previous draft failed these automated checks:\n${describeIssues(validation)}\nFix every point and keep everything else consistent.`;
      log.info({ attempt, issues: validation.issues }, "draft failed validation");
    }
    if (!output || !validation) throw new Error("no draft produced");

    const needsReview = campaign.approvalMode === "manual" || !validation.ok;
    const status = needsReview ? "pending_review" : "approved";
    const threaded = step.threaded && job.step > 1;
    const anchor = threaded ? previous.filter((p) => p.direction === "outbound").at(-1) : undefined;
    const subject = threaded && anchor ? (output.subject.toLowerCase().startsWith("re:") ? output.subject : `Re: ${anchor.subject.replace(/^re:\s*/i, "")}`) : output.subject;

    const matched = output.selectedServices.map((s) => ({
      serviceId: s.serviceId,
      serviceName: s.serviceName,
      fitScore: s.fitScore,
      rationale: s.rationale,
    }));

    await ctx.db.transaction(async (tx) => {
      if (job.regenerate) {
        await tx.update(emails).set({ status: "rejected", updatedAt: new Date() }).where(eq(emails.id, job.regenerate.emailId));
      }
      const [email] = await tx
        .insert(emails)
        .values({
          leadId: lead.id,
          campaignId: campaign.id,
          step: job.step,
          direction: "outbound",
          status,
          fromEmail: sender.fromEmail,
          toEmail: lead.email,
          subject,
          bodyText: output!.bodyText.trim(),
          llmMeta,
          validation,
        })
        .returning();
      await tx
        .update(leads)
        .set({ status, matchedServices: matched, updatedAt: new Date() })
        .where(eq(leads.id, lead.id));
      if (status === "approved") {
        await ctx.queue.publish<SendJob>(JOB_QUEUES.send, { emailId: email.id }, { singletonKey: `send:${email.id}` });
      }
    });
    ctx.metrics.emit("drafts_created", 1, { step: String(job.step) });
    log.info({ status, validationOk: validation.ok }, "draft stored");
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await ctx.db
      .update(leads)
      .set({ status: "failed", lastError: `draft: ${message}`.slice(0, 2000), updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
    log.error({ err }, "draft failed");
    throw err;
  }
}

export async function previousEmails(ctx: AppContext, leadId: string): Promise<PreviousEmail[]> {
  const rows = await ctx.db
    .select()
    .from(emails)
    .where(eq(emails.leadId, leadId))
    .orderBy(asc(emails.createdAt));
  return rows
    .filter((e) => e.direction === "inbound" || e.status === "sent" || e.status === "delivered")
    .map((e) => ({
      step: e.step,
      subject: e.subject,
      bodyText: e.bodyText,
      sentAt: e.sentAt?.toISOString() ?? null,
      direction: e.direction,
    }));
}

export type { CampaignRow, LeadRow };
