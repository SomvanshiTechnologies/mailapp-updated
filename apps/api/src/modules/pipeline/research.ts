import { eq } from "drizzle-orm";
import { JOB_QUEUES, TERMINAL_LEAD_STATUSES } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, leads } from "../../db/schema.js";
import type { DraftJob, ResearchJob } from "../../jobs/types.js";
import { loadInstructionBundle } from "../instructions/service.js";
import { listActiveServices } from "../services/routes.js";
import { fetchWebsiteExtract, normaliseWebsiteUrl } from "./website.js";

/**
 * Research a single lead: fetch the website, run the LLM research, store the persona and
 * hand over to drafting. Throws on transient failures so pg-boss retries; permanent
 * outcomes are recorded on the lead.
 */
export async function runResearchJob(ctx: AppContext, job: ResearchJob): Promise<void> {
  const log = ctx.logger.child({ job: "research", leadId: job.leadId });
  const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, job.leadId)).limit(1);
  if (!lead) return log.warn("lead not found");
  if (TERMINAL_LEAD_STATUSES.has(lead.status)) return log.info({ status: lead.status }, "lead terminal, skipping");
  const [campaign] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, lead.campaignId)).limit(1);
  if (!campaign || campaign.status !== "active") return log.info({ status: campaign?.status }, "campaign not active, skipping");

  await ctx.db.update(leads).set({ status: "researching", lastError: null, updatedAt: new Date() }).where(eq(leads.id, lead.id));
  const started = Date.now();
  try {
    const settings = await ctx.settings.get();
    const url = normaliseWebsiteUrl(lead.website, lead.email);
    const website = url && ctx.config.WEBSITE_FETCH_ENABLED ? await fetchWebsiteExtract(url) : null;
    const [bundle, services] = await Promise.all([loadInstructionBundle(ctx.db, campaign.createdBy), listActiveServices(ctx, campaign.serviceIds ?? [])]);
    const result = await ctx.llm.research({
      lead,
      website,
      companyProfile: bundle.companyProfile,
      serviceSummaries: services.map((s) => `${s.name}: ${s.description.slice(0, 200)}`),
      model: settings.researchModel,
      webSearch: settings.webSearchEnabled && ctx.config.LLM_WEB_SEARCH,
    });
    await ctx.db
      .update(leads)
      .set({
        status: "researched",
        persona: result.output,
        researchRaw: {
          findings: result.notes ?? null,
          website: website ? { url: website.url, title: website.title, fetchedAt: website.fetchedAt } : null,
          model: result.model,
          usage: result.usage,
          durationMs: result.durationMs,
        },
        updatedAt: new Date(),
      })
      .where(eq(leads.id, lead.id));
    ctx.metrics.emit("research_completed");
    log.info({ ms: Date.now() - started, confidence: result.output.confidence }, "research complete");
    await ctx.queue.publish<DraftJob>(JOB_QUEUES.draft, { leadId: lead.id, step: 1 }, { singletonKey: `draft:${lead.id}:1` });
  } catch (err) {
    ctx.metrics.emit("research_failures");
    const message = (err as Error).message ?? String(err);
    await ctx.db
      .update(leads)
      .set({ status: "failed", lastError: `research: ${message}`.slice(0, 2000), updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
    log.error({ err }, "research failed");
    throw err;
  }
}
