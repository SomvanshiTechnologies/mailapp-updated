import { and, eq, inArray, lte } from "drizzle-orm";
import { FOLLOWUP_ELIGIBLE_LEAD_STATUSES, JOB_QUEUES } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, leads } from "../../db/schema.js";
import type { DraftJob } from "../../jobs/types.js";
import { maybeCompleteCampaign } from "../campaigns/service.js";

/**
 * Runs every minute: queue the next sequence step for leads whose wait has elapsed and no
 * reply/bounce/complaint/unsubscribe happened, and complete campaigns with nothing left.
 */
export async function runFollowupTick(ctx: AppContext, now: Date = new Date()): Promise<{ scheduled: number; completed: number }> {
  const log = ctx.logger.child({ job: "followup.tick" });
  const due = await ctx.db
    .select({ lead: leads, campaign: campaigns })
    .from(leads)
    .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .where(and(inArray(leads.status, [...FOLLOWUP_ELIGIBLE_LEAD_STATUSES]), lte(leads.nextActionAt, now), eq(campaigns.status, "active")))
    .limit(500);

  let scheduled = 0;
  let completed = 0;
  const touchedCampaigns = new Set<string>();
  for (const { lead, campaign } of due) {
    touchedCampaigns.add(campaign.id);
    const nextStep = lead.currentStep + 1;
    const step = campaign.sequence.find((s) => s.step === nextStep);
    if (!step) {
      await ctx.db.update(leads).set({ status: "completed", nextActionAt: null, updatedAt: now }).where(eq(leads.id, lead.id));
      completed++;
      continue;
    }
    // Clear nextActionAt first so a slow drafter cannot be double-scheduled by the next tick.
    await ctx.db.update(leads).set({ nextActionAt: null, updatedAt: now }).where(eq(leads.id, lead.id));
    await ctx.queue.publish<DraftJob>(JOB_QUEUES.draft, { leadId: lead.id, step: nextStep }, { singletonKey: `draft:${lead.id}:${nextStep}` });
    scheduled++;
  }
  ctx.metrics.emit("followups_scheduled", scheduled);

  // Campaign completion sweep (cheap: only active campaigns).
  const active = await ctx.db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.status, "active"));
  let campaignsCompleted = 0;
  for (const c of active) if (await maybeCompleteCampaign(ctx, c.id)) campaignsCompleted++;
  if (scheduled || completed || campaignsCompleted) log.info({ scheduled, completed, campaignsCompleted }, "followup tick");
  return { scheduled, completed };
}
