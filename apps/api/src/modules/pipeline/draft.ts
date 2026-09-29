import { and, asc, eq } from "drizzle-orm";
import { JOB_QUEUES, TERMINAL_LEAD_STATUSES, type DraftOutput, type HardRules, type SequenceStep, type TokenUsage } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, emails, leads, type CampaignRow, type LeadRow, type ServiceRow } from "../../db/schema.js";
import type { DraftJob, SendJob } from "../../jobs/types.js";
import { loadInstructionBundle } from "../instructions/service.js";
import { listActiveServices } from "../services/routes.js";
import { resolveSender } from "../settings/sender.js";
import { resolveCampaignPlan, type CampaignModelPlan } from "../llm/catalogue.js";
import type { DraftInput, InstructionBundle, PreviousEmail } from "../llm/provider.js";
import { queueBatchItem } from "../llm/batch/queue.js";
import { attachCostToEmail } from "../llm/usage.js";
import { failLead } from "./research.js";
import { describeIssues, validateDraft } from "./validator.js";

/** Attempts allowed per draft: the first try plus one validator-feedback retry. */
export const MAX_DRAFT_ATTEMPTS = 2;

export interface PreparedDraft {
  lead: LeadRow;
  campaign: CampaignRow;
  plan: CampaignModelPlan;
  step: SequenceStep;
  hardRules: HardRules;
  sender: Awaited<ReturnType<typeof resolveSender>>;
  bundle: InstructionBundle;
  services: ServiceRow[];
  previous: PreviousEmail[];
  input: DraftInput;
}

/**
 * Assemble a draft request. Returns null when the lead is no longer eligible, or
 * `{ completed: true }` when the requested step is past the end of the sequence.
 */
export async function prepareDraft(
  ctx: AppContext,
  job: DraftJob,
  opts: { feedback?: string | null } = {},
): Promise<PreparedDraft | { completed: true } | null> {
  const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, job.leadId)).limit(1);
  if (!lead) return null;
  if (TERMINAL_LEAD_STATUSES.has(lead.status)) return null;
  if (!lead.persona) return null;
  const [campaign] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, lead.campaignId)).limit(1);
  if (!campaign || campaign.status !== "active") return null;

  const step = campaign.sequence.find((s) => s.step === job.step);
  if (!step) return { completed: true };

  const settings = await ctx.settings.get();
  const plan = resolveCampaignPlan(settings, campaign, { forceMock: ctx.config.LLM_PROVIDER === "mock" });
  const hardRules = await ctx.settings.effectiveHardRules(campaign.hardRulesOverride);
  const sender = await resolveSender(ctx, campaign);
  const [bundle, services] = await Promise.all([
    loadInstructionBundle(ctx.db, sender.ownerId),
    listActiveServices(ctx, campaign.serviceIds ?? []),
  ]);
  const previous = await previousEmails(ctx, lead.id);
  const input: DraftInput = {
    lead,
    persona: lead.persona,
    services,
    instructions: bundle,
    hardRules,
    step,
    totalSteps: campaign.sequence.length,
    previousEmails: previous,
    campaignGuidance: campaign.extraGuidance,
    regenerationFeedback: opts.feedback ?? job.regenerate?.feedback ?? null,
    senderName: sender.fromName,
    model: plan.draft,
  };
  return { lead, campaign, plan, step, hardRules, sender, bundle, services, previous, input };
}

/** True when a draft already exists for this step and should not be produced again. */
export async function draftAlreadyExists(ctx: AppContext, leadId: string, step: number): Promise<string | null> {
  const [existing] = await ctx.db
    .select({ id: emails.id, status: emails.status })
    .from(emails)
    .where(and(eq(emails.leadId, leadId), eq(emails.step, step), eq(emails.direction, "outbound")))
    .limit(1);
  if (existing && existing.status !== "rejected" && existing.status !== "failed") return existing.id;
  return null;
}

export interface DraftOutcome {
  output: DraftOutput;
  model: string;
  usage: TokenUsage;
  durationMs: number;
  attempt: number;
  costMicroUsd: number;
  /** Set when the previous attempt's validator feedback produced this draft. */
  feedback: string | null;
}

/**
 * Store a finished draft: thread the subject, record the matched services, insert the email
 * and queue the send when the campaign auto-approves. Shared by the synchronous path and the
 * batch runner.
 */
export async function applyDraftResult(
  ctx: AppContext,
  prepared: PreparedDraft,
  job: DraftJob,
  outcome: DraftOutcome,
): Promise<{ emailId: string; status: string }> {
  const { lead, campaign, step, hardRules, sender, previous } = prepared;
  const output = outcome.output;
  const validation = validateDraft(output.subject, output.bodyText, hardRules, { toEmail: lead.email });

  const llmMeta: Record<string, unknown> = {
    model: outcome.model,
    modelKey: prepared.plan.draft.modelKey,
    provider: prepared.plan.draft.provider,
    batch: prepared.plan.draft.batch,
    usage: outcome.usage,
    costMicroUsd: outcome.costMicroUsd,
    durationMs: outcome.durationMs,
    attempt: outcome.attempt,
    pitchAngle: output.pitchAngle,
    callToAction: output.callToAction,
    personalisationUsed: output.personalisationUsed,
    selfCheck: output.selfCheck,
    selectedServices: output.selectedServices,
    regenerationFeedback: outcome.feedback,
  };

  const needsReview = campaign.approvalMode === "manual" || !validation.ok;
  const status = needsReview ? "pending_review" : "approved";
  const threaded = step.threaded && job.step > 1;
  const anchor = threaded ? previous.filter((p) => p.direction === "outbound").at(-1) : undefined;
  const subject =
    threaded && anchor
      ? output.subject.toLowerCase().startsWith("re:")
        ? output.subject
        : `Re: ${anchor.subject.replace(/^re:\s*/i, "")}`
      : output.subject;

  const matched = output.selectedServices.map((s) => ({
    serviceId: s.serviceId,
    serviceName: s.serviceName,
    fitScore: s.fitScore,
    rationale: s.rationale,
  }));

  let emailId = "";
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
        bodyText: output.bodyText.trim(),
        llmMeta,
        costMicroUsd: outcome.costMicroUsd,
        validation,
      })
      .returning();
    emailId = email.id;
    await tx.update(leads).set({ status, matchedServices: matched, updatedAt: new Date() }).where(eq(leads.id, lead.id));
    if (status === "approved") {
      await ctx.queue.publish<SendJob>(JOB_QUEUES.send, { emailId: email.id }, { singletonKey: `send:${email.id}` });
    }
  });
  // Link the drafting spend to the email it produced, so per-email cost is queryable.
  await attachCostToEmail(ctx, { leadId: lead.id, step: job.step, emailId, costMicroUsd: outcome.costMicroUsd });
  ctx.metrics.emit("drafts_created", 1, { step: String(job.step) });
  return { emailId, status };
}

/** The feedback message handed back to the model after a failed validation. */
export function validatorFeedback(validation: ReturnType<typeof validateDraft>): string {
  return `The previous draft failed these automated checks:\n${describeIssues(validation)}\nFix every point and keep everything else consistent.`;
}

/**
 * Draft one email for a lead at a given sequence step. Runs the validator; on failure the
 * model gets one more attempt with the validator's feedback. Drafts that still fail go to
 * the review queue flagged, regardless of approval mode. When the campaign's drafting model
 * is a batch model the request is queued and the batch tick finishes the job.
 */
export async function runDraftJob(ctx: AppContext, job: DraftJob): Promise<void> {
  const log = ctx.logger.child({ job: "draft", leadId: job.leadId, step: job.step });
  const prepared = await prepareDraft(ctx, job);
  if (!prepared) return log.info("lead or campaign not eligible for drafting, skipping");
  if ("completed" in prepared) {
    log.warn("step not in sequence; marking completed");
    await ctx.db.update(leads).set({ status: "completed", nextActionAt: null, updatedAt: new Date() }).where(eq(leads.id, job.leadId));
    return;
  }
  // Guard against duplicate drafts for the same step (job retries, double publishes).
  if (!job.regenerate) {
    const existing = await draftAlreadyExists(ctx, prepared.lead.id, job.step);
    if (existing) return log.info({ emailId: existing }, "draft already exists for step");
  }

  await ctx.db.update(leads).set({ status: "drafting", lastError: null, updatedAt: new Date() }).where(eq(leads.id, prepared.lead.id));

  if (prepared.plan.draft.batch) {
    const queued = await queueBatchItem(ctx, {
      purpose: "draft",
      lead: prepared.lead,
      campaignId: prepared.lead.campaignId,
      model: prepared.plan.draft,
      strategy: prepared.plan.resolved.batchStrategy,
      step: job.step,
      attempt: 1,
      prepare: async (adapter) => adapter.prepareDraft?.(prepared.input) ?? null,
      context: { regenerate: job.regenerate ?? null },
    });
    if (queued) {
      log.info({ model: prepared.plan.draft.modelKey }, "draft queued for batch");
      return;
    }
    log.warn({ model: prepared.plan.draft.modelKey }, "batch queue unavailable, drafting inline");
  }

  try {
    let feedback = job.regenerate?.feedback ?? null;
    let outcome: DraftOutcome | null = null;
    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
      const result = await ctx.llm.draft({ ...prepared.input, regenerationFeedback: feedback });
      const validation = validateDraft(result.output.subject, result.output.bodyText, prepared.hardRules, { toEmail: prepared.lead.email });
      outcome = {
        output: result.output,
        model: result.model,
        usage: result.usage,
        durationMs: result.durationMs,
        attempt,
        costMicroUsd: result.costMicroUsd ?? 0,
        feedback,
      };
      if (validation.ok) break;
      ctx.metrics.emit("drafts_rejected_by_validator");
      feedback = validatorFeedback(validation);
      log.info({ attempt, issues: validation.issues }, "draft failed validation");
    }
    if (!outcome) throw new Error("no draft produced");
    const { status } = await applyDraftResult(ctx, prepared, job, outcome);
    log.info({ status, cost: outcome.costMicroUsd }, "draft stored");
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await failLead(ctx, prepared.lead.id, "draft", message);
    log.error({ err }, "draft failed");
    throw err;
  }
}

export async function previousEmails(ctx: AppContext, leadId: string): Promise<PreviousEmail[]> {
  const rows = await ctx.db.select().from(emails).where(eq(emails.leadId, leadId)).orderBy(asc(emails.createdAt));
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
