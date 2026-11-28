import { eq } from "drizzle-orm";
import { JOB_QUEUES, TERMINAL_LEAD_STATUSES, type MatchedService, type QualificationResult } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, leads, type LeadRow } from "../../db/schema.js";
import type { DraftJob, QualifyJob } from "../../jobs/types.js";
import { loadInstructionBundle } from "../instructions/service.js";
import { listActiveServices } from "../services/routes.js";
import { resolveCampaignPlan, type ResolvedModel } from "../llm/catalogue.js";
import { failLead } from "./research.js";
import { finaliseQualification, leadStatusForOutcome, preQualify } from "./qualification.js";

/** Only leads that have just been researched (or were mid-qualification) are qualified. */
const QUALIFIABLE = new Set(["researched", "qualifying"]);

/**
 * Qualification always runs synchronously: it is short and gates drafting, so it does not
 * wait on a provider batch. A batch-flagged drafting model is therefore called directly at
 * its list (non-batch) rates.
 */
function syncModel(model: ResolvedModel): ResolvedModel {
  return model.batch ? { ...model, batch: false, rates: model.listRates } : model;
}

/** Store a qualification decision on the lead and, when qualified, hand it to drafting. */
export async function applyQualification(ctx: AppContext, lead: LeadRow, result: QualificationResult): Promise<void> {
  const matched: MatchedService[] = result.service
    ? [{ serviceId: result.service.serviceId, serviceName: result.service.serviceName, fitScore: result.service.fitScore, rationale: result.service.rationale }]
    : [];
  await ctx.db
    .update(leads)
    .set({
      status: leadStatusForOutcome(result.outcome),
      qualificationStatus: result.outcome,
      qualification: result,
      matchedServices: matched,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, lead.id));
  ctx.metrics.emit("leads_qualified", 1, { outcome: result.outcome, decidedBy: result.decidedBy });
  if (result.outcome === "qualified") {
    await ctx.queue.publish<DraftJob>(JOB_QUEUES.draft, { leadId: lead.id, step: 1 }, { singletonKey: `draft:${lead.id}:1:${Date.now()}` });
  }
}

/**
 * Qualify one researched lead and match a service: rule pre-check, model call, rule checks on
 * the answer, then store. Only qualified leads continue to drafting; unqualified leads stop,
 * and needs-research / human-review leads wait on hold for an operator.
 */
export async function runQualifyJob(ctx: AppContext, job: QualifyJob): Promise<void> {
  const log = ctx.logger.child({ job: "qualify", leadId: job.leadId });
  const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, job.leadId)).limit(1);
  if (!lead || TERMINAL_LEAD_STATUSES.has(lead.status) || !QUALIFIABLE.has(lead.status)) {
    return log.info({ status: lead?.status }, "lead not eligible for qualification, skipping");
  }
  const [campaign] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, lead.campaignId)).limit(1);
  if (!campaign || campaign.status !== "active") return log.info("campaign not active, skipping");

  await ctx.db.update(leads).set({ status: "qualifying", updatedAt: new Date() }).where(eq(leads.id, lead.id));

  const ruled = preQualify(lead.persona);
  if (ruled) {
    await applyQualification(ctx, lead, ruled);
    return log.info({ outcome: ruled.outcome }, "qualified by rule");
  }

  const settings = await ctx.settings.get();
  const plan = resolveCampaignPlan(settings, campaign, { forceMock: ctx.config.LLM_PROVIDER === "mock" });
  const [bundle, services] = await Promise.all([
    loadInstructionBundle(ctx.db, campaign.createdBy),
    listActiveServices(ctx, campaign.serviceIds ?? []),
  ]);
  const persona = lead.persona!;
  try {
    const res = await ctx.llm.qualify({
      lead,
      persona,
      researchStatus: lead.researchStatus,
      researchIssues: lead.researchIssues ?? [],
      services,
      companyProfile: bundle.companyProfile,
      targetingCriteria: bundle.targetingCriteria,
      model: syncModel(plan.draft),
    });
    const result = finaliseQualification(res.output, {
      persona,
      services,
      minFitScore: ctx.config.QUALIFICATION_MIN_FIT_SCORE,
      model: res.model,
    });
    await applyQualification(ctx, lead, result);
    log.info({ outcome: result.outcome, modelOutcome: result.modelOutcome, service: result.service?.serviceName ?? null }, "qualification complete");
  } catch (err) {
    ctx.metrics.emit("qualification_failures");
    await failLead(ctx, lead.id, "qualify", (err as Error).message ?? String(err));
    log.error({ err }, "qualification failed");
    throw err;
  }
}
