import { eq } from "drizzle-orm";
import { JOB_QUEUES, TERMINAL_LEAD_STATUSES, type Persona, type TokenUsage } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, leads, type CampaignRow, type LeadRow } from "../../db/schema.js";
import type { DraftJob, ResearchJob } from "../../jobs/types.js";
import { loadInstructionBundle } from "../instructions/service.js";
import { listActiveServices } from "../services/routes.js";
import { resolveCampaignPlan, type CampaignModelPlan } from "../llm/catalogue.js";
import type { ResearchInput, WebsiteExtract } from "../llm/provider.js";
import { queueBatchItem } from "../llm/batch/queue.js";
import { fetchWebsiteExtract, normaliseWebsiteUrl } from "./website.js";

export interface PreparedResearch {
  lead: LeadRow;
  campaign: CampaignRow;
  plan: CampaignModelPlan;
  input: ResearchInput;
  website: WebsiteExtract | null;
}

/**
 * Assemble everything the research call needs. Returns null when the lead or campaign is no
 * longer eligible, so both the synchronous job and the batch flush can bail the same way.
 */
export async function prepareResearch(ctx: AppContext, leadId: string): Promise<PreparedResearch | null> {
  const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return null;
  if (TERMINAL_LEAD_STATUSES.has(lead.status)) return null;
  const [campaign] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, lead.campaignId)).limit(1);
  if (!campaign || campaign.status !== "active") return null;

  const settings = await ctx.settings.get();
  const plan = resolveCampaignPlan(settings, campaign, { forceMock: ctx.config.LLM_PROVIDER === "mock" });
  const url = normaliseWebsiteUrl(lead.website, lead.email);
  const website = url && ctx.config.WEBSITE_FETCH_ENABLED ? await fetchWebsiteExtract(url) : null;
  const [bundle, services] = await Promise.all([
    loadInstructionBundle(ctx.db, campaign.createdBy),
    listActiveServices(ctx, campaign.serviceIds ?? []),
  ]);
  const input: ResearchInput = {
    lead,
    website,
    companyProfile: bundle.companyProfile,
    serviceSummaries: services.map((s) => `${s.name}: ${s.description.slice(0, 200)}`),
    model: plan.research,
    profile: plan.profile,
    researchMode: plan.researchMode,
    // Only ground the research when the org allows it and the chosen model can.
    webSearch: settings.webSearchEnabled && ctx.config.LLM_WEB_SEARCH && plan.research.supportsWebSearch,
  };
  return { lead, campaign, plan, input, website };
}

export interface ResearchOutcome {
  persona: Persona;
  notes: string | null;
  model: string;
  usage: TokenUsage;
  durationMs: number;
}

/**
 * Store a completed persona and hand the lead over to drafting. Shared by the synchronous
 * path and the batch runner, so a batched lead ends in exactly the same state.
 */
export async function applyResearchResult(
  ctx: AppContext,
  lead: LeadRow,
  website: WebsiteExtract | null,
  outcome: ResearchOutcome,
): Promise<void> {
  await ctx.db
    .update(leads)
    .set({
      status: "researched",
      persona: outcome.persona,
      researchRaw: {
        findings: outcome.notes ?? null,
        website: website ? { url: website.url, title: website.title, fetchedAt: website.fetchedAt } : null,
        model: outcome.model,
        usage: outcome.usage,
        durationMs: outcome.durationMs,
      },
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, lead.id));
  ctx.metrics.emit("research_completed");
  await ctx.queue.publish<DraftJob>(JOB_QUEUES.draft, { leadId: lead.id, step: 1 }, { singletonKey: `draft:${lead.id}:1` });
}

/** Mark a lead as failed with a message the review UI can show. */
export async function failLead(ctx: AppContext, leadId: string, prefix: string, message: string): Promise<void> {
  await ctx.db
    .update(leads)
    .set({ status: "failed", lastError: `${prefix}: ${message}`.slice(0, 2000), updatedAt: new Date() })
    .where(eq(leads.id, leadId));
}

/**
 * Research a single lead: fetch the website, run the LLM research, store the persona and
 * hand over to drafting. Throws on transient failures so pg-boss retries; permanent
 * outcomes are recorded on the lead. When the campaign's research model is a batch model the
 * request is queued instead and the batch tick finishes the job.
 */
export async function runResearchJob(ctx: AppContext, job: ResearchJob): Promise<void> {
  const log = ctx.logger.child({ job: "research", leadId: job.leadId });
  const prepared = await prepareResearch(ctx, job.leadId);
  if (!prepared) return log.info("lead or campaign not eligible for research, skipping");
  const { lead, plan, input, website } = prepared;

  await ctx.db.update(leads).set({ status: "researching", lastError: null, updatedAt: new Date() }).where(eq(leads.id, lead.id));

  if (plan.research.batch) {
    const queued = await queueBatchItem(ctx, {
      purpose: "research",
      lead,
      campaignId: lead.campaignId,
      model: plan.research,
      strategy: plan.resolved.batchStrategy,
      step: 0,
      attempt: 1,
      prepare: async (adapter) => adapter.prepareResearch?.(input) ?? null,
      context: { website: website ? { url: website.url, title: website.title, fetchedAt: website.fetchedAt, description: website.description, headings: website.headings, text: "" } : null },
    });
    if (queued) {
      log.info({ model: plan.research.modelKey }, "research queued for batch");
      return;
    }
    // Falling through means the provider could not batch after all; run it inline.
    log.warn({ model: plan.research.modelKey }, "batch queue unavailable, running research inline");
  }

  const started = Date.now();
  try {
    const result = await ctx.llm.research(input);
    await applyResearchResult(ctx, lead, website, {
      persona: result.output,
      notes: result.notes ?? null,
      model: result.model,
      usage: result.usage,
      durationMs: result.durationMs,
    });
    log.info({ ms: Date.now() - started, confidence: result.output.confidence, cost: result.costMicroUsd }, "research complete");
  } catch (err) {
    ctx.metrics.emit("research_failures");
    const message = (err as Error).message ?? String(err);
    await failLead(ctx, lead.id, "research", message);
    log.error({ err }, "research failed");
    throw err;
  }
}
