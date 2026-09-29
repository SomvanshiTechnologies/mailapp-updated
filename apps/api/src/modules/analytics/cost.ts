import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import {
  PROVIDER_LABELS,
  estimateCost,
  findModelSpec,
  type BatchDto,
  type CampaignCostDto,
  type CostByModel,
  type CostSummary,
  type LlmPurpose,
  type LlmUsageDto,
} from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, emails, leads, llmBatchItems, llmBatches, llmCalls } from "../../db/schema.js";
import { resolveCampaignPlan } from "../llm/catalogue.js";

export const EMPTY_COST: CostSummary = {
  totalMicroUsd: 0,
  researchMicroUsd: 0,
  draftMicroUsd: 0,
  perLeadMicroUsd: 0,
  perEmailMicroUsd: 0,
  calls: 0,
  failedCalls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  leads: 0,
  emails: 0,
  batchSharePct: 0,
};

/** Label a model key even when the model has since left the catalogue. */
function labelFor(modelKey: string, model: string): string {
  return findModelSpec(modelKey)?.label ?? findModelSpec(model)?.label ?? (model || modelKey);
}

const COST_COLUMNS = {
  calls: sql<number>`count(*)::int`,
  failedCalls: sql<number>`count(*) filter (where ${llmCalls.ok} = false)::int`,
  total: sql<number>`coalesce(sum(${llmCalls.costMicroUsd}),0)::bigint`,
  research: sql<number>`coalesce(sum(${llmCalls.costMicroUsd}) filter (where ${llmCalls.purpose} in ('research','persona')),0)::bigint`,
  draft: sql<number>`coalesce(sum(${llmCalls.costMicroUsd}) filter (where ${llmCalls.purpose} = 'draft'),0)::bigint`,
  batch: sql<number>`coalesce(sum(${llmCalls.costMicroUsd}) filter (where ${llmCalls.batch}),0)::bigint`,
  inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}),0)::bigint`,
  cachedInputTokens: sql<number>`coalesce(sum(${llmCalls.cacheReadTokens} + ${llmCalls.cacheWriteTokens}),0)::bigint`,
  outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}),0)::bigint`,
};

// Postgres returns bigint sums as strings; coerce every aggregate through Number.
const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

function summarise(
  row: Record<string, unknown> | undefined,
  divisors: { leads: number; emails: number },
): CostSummary {
  const total = n(row?.total);
  return {
    totalMicroUsd: total,
    researchMicroUsd: n(row?.research),
    draftMicroUsd: n(row?.draft),
    perLeadMicroUsd: divisors.leads > 0 ? Math.round(total / divisors.leads) : 0,
    perEmailMicroUsd: divisors.emails > 0 ? Math.round(n(row?.draft) / divisors.emails) : 0,
    calls: n(row?.calls),
    failedCalls: n(row?.failedCalls),
    inputTokens: n(row?.inputTokens),
    cachedInputTokens: n(row?.cachedInputTokens),
    outputTokens: n(row?.outputTokens),
    leads: divisors.leads,
    emails: divisors.emails,
    batchSharePct: total > 0 ? Math.round((n(row?.batch) / total) * 1000) / 10 : 0,
  };
}

/** Spend for one campaign. Divisors are the campaign's leads and its outbound emails. */
export async function campaignCost(ctx: AppContext, campaignId: string): Promise<CostSummary> {
  const [row] = await ctx.db.select(COST_COLUMNS).from(llmCalls).where(eq(llmCalls.campaignId, campaignId));
  const [counts] = await ctx.db
    .select({
      leads: sql<number>`count(*)::int`,
    })
    .from(leads)
    .where(eq(leads.campaignId, campaignId));
  const [emailCounts] = await ctx.db
    .select({ emails: sql<number>`count(*)::int` })
    .from(emails)
    .where(and(eq(emails.campaignId, campaignId), eq(emails.direction, "outbound")));
  return summarise(row, { leads: n(counts?.leads), emails: n(emailCounts?.emails) });
}

/** Spend for many campaigns at once, for the campaign list. */
export async function campaignCostMap(ctx: AppContext, campaignIds: string[]): Promise<Map<string, CostSummary>> {
  const out = new Map<string, CostSummary>();
  if (!campaignIds.length) return out;
  const rows = await ctx.db
    .select({ campaignId: llmCalls.campaignId, ...COST_COLUMNS })
    .from(llmCalls)
    .where(inArray(llmCalls.campaignId, campaignIds))
    .groupBy(llmCalls.campaignId);
  const leadRows = await ctx.db
    .select({ campaignId: leads.campaignId, leads: sql<number>`count(*)::int` })
    .from(leads)
    .where(inArray(leads.campaignId, campaignIds))
    .groupBy(leads.campaignId);
  const emailRows = await ctx.db
    .select({ campaignId: emails.campaignId, emails: sql<number>`count(*)::int` })
    .from(emails)
    .where(and(inArray(emails.campaignId, campaignIds), eq(emails.direction, "outbound")))
    .groupBy(emails.campaignId);
  const leadCount = new Map(leadRows.map((r) => [r.campaignId, n(r.leads)]));
  const emailCount = new Map(emailRows.map((r) => [r.campaignId, n(r.emails)]));
  for (const id of campaignIds) out.set(id, { ...EMPTY_COST, leads: leadCount.get(id) ?? 0, emails: emailCount.get(id) ?? 0 });
  for (const r of rows) {
    if (!r.campaignId) continue;
    out.set(r.campaignId, summarise(r, { leads: leadCount.get(r.campaignId) ?? 0, emails: emailCount.get(r.campaignId) ?? 0 }));
  }
  return out;
}

/** Spend grouped by model, optionally scoped to one campaign or a date range. */
export async function costByModel(
  ctx: AppContext,
  where: SQL | undefined,
): Promise<CostByModel[]> {
  const rows = await ctx.db
    .select({
      modelKey: llmCalls.modelKey,
      model: llmCalls.model,
      provider: llmCalls.provider,
      batch: llmCalls.batch,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}),0)::bigint`,
      cachedInputTokens: sql<number>`coalesce(sum(${llmCalls.cacheReadTokens} + ${llmCalls.cacheWriteTokens}),0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}),0)::bigint`,
      microUsd: sql<number>`coalesce(sum(${llmCalls.costMicroUsd}),0)::bigint`,
    })
    .from(llmCalls)
    .where(where)
    .groupBy(llmCalls.modelKey, llmCalls.model, llmCalls.provider, llmCalls.batch)
    .orderBy(desc(sql`coalesce(sum(${llmCalls.costMicroUsd}),0)`));
  return rows.map((r) => ({
    modelKey: r.modelKey || r.model,
    provider: r.provider,
    label: labelFor(r.modelKey, r.model),
    batch: r.batch,
    purpose: "all" as const,
    calls: n(r.calls),
    inputTokens: n(r.inputTokens),
    cachedInputTokens: n(r.cachedInputTokens),
    outputTokens: n(r.outputTokens),
    microUsd: n(r.microUsd),
  }));
}

/**
 * The campaign cost panel: what has been spent, what the rest is expected to cost, the
 * breakdown by model, and any batch still in flight.
 *
 * The estimate blends: once a campaign has enough finished calls of a kind, its own measured
 * average per lead / per email replaces the static profile figure, so the projection converges
 * on reality as the run proceeds.
 */
export async function campaignCostDto(ctx: AppContext, campaignId: string): Promise<CampaignCostDto> {
  const [campaign] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  const settings = await ctx.settings.get();
  const plan = resolveCampaignPlan(settings, campaign ?? null, { forceMock: ctx.config.LLM_PROVIDER === "mock" });
  const actual = await campaignCost(ctx, campaignId);

  // Remaining work: leads with no persona yet, and emails the sequence still owes.
  const [leadRow] = await ctx.db
    .select({
      total: sql<number>`count(*)::int`,
      researched: sql<number>`count(*) filter (where ${leads.persona} is not null)::int`,
      active: sql<number>`count(*) filter (where ${leads.status} not in ('replied','bounced','complained','unsubscribed','suppressed','invalid','rejected','completed','skipped'))::int`,
    })
    .from(leads)
    .where(eq(leads.campaignId, campaignId));
  const [emailRow] = await ctx.db
    .select({ drafted: sql<number>`count(*)::int` })
    .from(emails)
    .where(and(eq(emails.campaignId, campaignId), eq(emails.direction, "outbound")));

  const totalLeads = n(leadRow?.total);
  const activeLeads = n(leadRow?.active);
  const steps = campaign?.sequence.length ?? 1;
  const leadsToResearch = Math.max(0, activeLeads - n(leadRow?.researched));
  // Only active leads will receive further steps; already-drafted emails are paid for.
  const emailsToDraft = Math.max(0, activeLeads * steps - n(emailRow?.drafted));

  // Measured averages, used once there is enough signal to beat the profile.
  const [measured] = await ctx.db
    .select({
      researchCalls: sql<number>`count(*) filter (where ${llmCalls.purpose} in ('research','persona') and ${llmCalls.ok})::int`,
      researchCost: sql<number>`coalesce(sum(${llmCalls.costMicroUsd}) filter (where ${llmCalls.purpose} in ('research','persona') and ${llmCalls.ok}),0)::bigint`,
      draftCalls: sql<number>`count(*) filter (where ${llmCalls.purpose} = 'draft' and ${llmCalls.ok})::int`,
      draftCost: sql<number>`coalesce(sum(${llmCalls.costMicroUsd}) filter (where ${llmCalls.purpose} = 'draft' and ${llmCalls.ok}),0)::bigint`,
    })
    .from(llmCalls)
    .where(eq(llmCalls.campaignId, campaignId));
  const researchedLeads = n(leadRow?.researched);
  const MIN_SAMPLE = 5;
  const observed = {
    researchMicroPerLead:
      researchedLeads >= MIN_SAMPLE && n(measured?.researchCalls) > 0 ? Math.round(n(measured?.researchCost) / researchedLeads) : undefined,
    draftMicroPerEmail:
      n(measured?.draftCalls) >= MIN_SAMPLE ? Math.round(n(measured?.draftCost) / n(measured?.draftCalls)) : undefined,
  };

  const estimate = estimateCost({
    leadsToResearch,
    emailsToDraft,
    researchMode: plan.researchMode,
    researchRates: plan.research.rates,
    draftRates: plan.draft.rates,
    observed,
  });

  return {
    actual: { ...actual, leads: totalLeads },
    estimate,
    byModel: await costByModel(ctx, eq(llmCalls.campaignId, campaignId)),
    ai: plan.resolved,
    batches: await campaignBatches(ctx, campaignId),
  };
}

/** Batches belonging to a campaign, newest first. */
export async function campaignBatches(ctx: AppContext, campaignId: string, limit = 20): Promise<BatchDto[]> {
  const rows = await ctx.db
    .select({ batch: llmBatches, campaignName: campaigns.name })
    .from(llmBatches)
    .leftJoin(campaigns, eq(campaigns.id, llmBatches.campaignId))
    .where(eq(llmBatches.campaignId, campaignId))
    .orderBy(desc(llmBatches.createdAt))
    .limit(limit);
  return rows.map(({ batch: b, campaignName }) => ({
    id: b.id,
    provider: b.provider,
    model: b.model,
    purpose: b.purpose,
    campaignId: b.campaignId,
    campaignName,
    externalId: b.externalId,
    status: b.status,
    strategy: b.strategy,
    requestCount: b.requestCount,
    succeeded: b.succeeded,
    errored: b.errored,
    microUsd: b.costMicroUsd,
    createdAt: b.createdAt.toISOString(),
    submittedAt: b.submittedAt?.toISOString() ?? null,
    completedAt: b.completedAt?.toISOString() ?? null,
    lastPolledAt: b.lastPolledAt?.toISOString() ?? null,
    error: b.error,
  }));
}

/** Count of requests still waiting to be submitted, per campaign. */
export async function pendingBatchItems(ctx: AppContext, campaignId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(llmBatchItems)
    .where(and(eq(llmBatchItems.campaignId, campaignId), inArray(llmBatchItems.status, ["pending", "submitted"])));
  return n(row?.n);
}

export interface LlmUsageRange {
  from: Date;
  to: Date;
  campaignId?: string;
  campaignIds?: string[];
}

/** Organisation-wide usage and spend for the dashboard. */
export async function llmUsageDto(ctx: AppContext, o: LlmUsageRange): Promise<LlmUsageDto> {
  const conds: SQL[] = [gte(llmCalls.createdAt, o.from), lte(llmCalls.createdAt, o.to)];
  if (o.campaignId) conds.push(eq(llmCalls.campaignId, o.campaignId));
  else if (o.campaignIds) conds.push(o.campaignIds.length ? inArray(llmCalls.campaignId, o.campaignIds) : sql`false`);
  const where = and(...conds);

  const [row] = await ctx.db
    .select({ ...COST_COLUMNS, avgLatencyMs: sql<number>`coalesce(avg(${llmCalls.durationMs}),0)::int` })
    .from(llmCalls)
    .where(where);

  const purposeRows = await ctx.db
    .select({
      purpose: llmCalls.purpose,
      calls: sql<number>`count(*)::int`,
      microUsd: sql<number>`coalesce(sum(${llmCalls.costMicroUsd}),0)::bigint`,
    })
    .from(llmCalls)
    .where(where)
    .groupBy(llmCalls.purpose);

  const dailyRows = await ctx.db
    .select({
      date: sql<string>`to_char(date_trunc('day', ${llmCalls.createdAt}), 'YYYY-MM-DD')`,
      microUsd: sql<number>`coalesce(sum(${llmCalls.costMicroUsd}),0)::bigint`,
      calls: sql<number>`count(*)::int`,
    })
    .from(llmCalls)
    .where(where)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  // Divide by the emails actually sent and leads actually touched in the same window, so
  // "cost per sent email" is a real unit economic rather than a ratio of unrelated totals.
  const sentConds: SQL[] = [eq(emails.direction, "outbound"), gte(emails.sentAt, o.from), lte(emails.sentAt, o.to)];
  if (o.campaignId) sentConds.push(eq(emails.campaignId, o.campaignId));
  else if (o.campaignIds) sentConds.push(o.campaignIds.length ? inArray(emails.campaignId, o.campaignIds) : sql`false`);
  const [sentRow] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(emails).where(and(...sentConds));

  const leadConds: SQL[] = [gte(leads.createdAt, o.from), lte(leads.createdAt, o.to)];
  if (o.campaignId) leadConds.push(eq(leads.campaignId, o.campaignId));
  else if (o.campaignIds) leadConds.push(o.campaignIds.length ? inArray(leads.campaignId, o.campaignIds) : sql`false`);
  const [leadRow] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(leads).where(and(...leadConds));

  const total = n(row?.total);
  const sent = n(sentRow?.n);
  const leadCount = n(leadRow?.n);
  return {
    range: { from: o.from.toISOString(), to: o.to.toISOString() },
    calls: n(row?.calls),
    failures: n(row?.failedCalls),
    avgLatencyMs: n(row?.avgLatencyMs),
    inputTokens: n(row?.inputTokens),
    outputTokens: n(row?.outputTokens),
    cacheReadTokens: n(row?.cachedInputTokens),
    cacheWriteTokens: 0,
    totalMicroUsd: total,
    microUsdPerSentEmail: sent > 0 ? Math.round(total / sent) : 0,
    microUsdPerLead: leadCount > 0 ? Math.round(total / leadCount) : 0,
    byModel: await costByModel(ctx, where),
    byPurpose: purposeRows.map((r) => ({ purpose: r.purpose as LlmPurpose, calls: n(r.calls), microUsd: n(r.microUsd) })),
    daily: dailyRows.map((r) => ({ date: r.date, microUsd: n(r.microUsd), calls: n(r.calls) })),
  };
}

export { PROVIDER_LABELS };
