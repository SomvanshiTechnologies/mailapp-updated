import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { OverviewAnalytics, TimeseriesPoint } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, emailEvents, emails, leads, llmCalls } from "../../db/schema.js";

export interface RangeOpts {
  from?: Date;
  to?: Date;
  campaignId?: string;
  /** Restrict to these campaigns (non-admin scope). undefined = no restriction. */
  campaignIds?: string[];
}

function range(o: RangeOpts): { from: Date; to: Date } {
  const to = o.to ?? new Date();
  const from = o.from ?? new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}

const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0);

/** Campaign filter for a column: explicit campaignId, else the caller's visible set. */
function campaignScope(o: RangeOpts, col: { campaignId: unknown } | typeof campaigns): SQL | undefined {
  const column = ("campaignId" in col ? col.campaignId : campaigns.id) as typeof campaigns.id;
  if (o.campaignId) return eq(column, o.campaignId);
  if (o.campaignIds) return o.campaignIds.length ? inArray(column, o.campaignIds) : sql`false`;
  return undefined;
}

export async function overview(ctx: AppContext, o: RangeOpts): Promise<OverviewAnalytics> {
  const { from, to } = range(o);
  const leadConds = [gte(leads.createdAt, from), lte(leads.createdAt, to)];
  const leadScope = campaignScope(o, leads);
  if (leadScope) leadConds.push(leadScope);

  const [leadTotals] = await ctx.db
    .select({
      leads: sql<number>`count(*)::int`,
      sent: sql<number>`count(*) filter (where ${leads.sentAt} is not null)::int`,
      delivered: sql<number>`count(*) filter (where ${leads.deliveredAt} is not null)::int`,
      opened: sql<number>`count(*) filter (where ${leads.openedAt} is not null)::int`,
      clicked: sql<number>`count(*) filter (where ${leads.clickedAt} is not null)::int`,
      replied: sql<number>`count(*) filter (where ${leads.repliedAt} is not null)::int`,
      bounced: sql<number>`count(*) filter (where ${leads.bouncedAt} is not null)::int`,
      complained: sql<number>`count(*) filter (where ${leads.complainedAt} is not null)::int`,
      unsubscribed: sql<number>`count(*) filter (where ${leads.unsubscribedAt} is not null)::int`,
      failed: sql<number>`count(*) filter (where ${leads.status} = 'failed')::int`,
      pendingReview: sql<number>`count(*) filter (where ${leads.status} = 'pending_review')::int`,
    })
    .from(leads)
    .where(and(...leadConds));

  const byCampaignRows = await ctx.db
    .select({
      campaignId: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      sent: sql<number>`count(${leads.id}) filter (where ${leads.sentAt} is not null)::int`,
      delivered: sql<number>`count(${leads.id}) filter (where ${leads.deliveredAt} is not null)::int`,
      opened: sql<number>`count(${leads.id}) filter (where ${leads.openedAt} is not null)::int`,
      replied: sql<number>`count(${leads.id}) filter (where ${leads.repliedAt} is not null)::int`,
      bounced: sql<number>`count(${leads.id}) filter (where ${leads.bouncedAt} is not null)::int`,
    })
    .from(campaigns)
    .leftJoin(leads, eq(leads.campaignId, campaigns.id))
    .where(campaignScope(o, campaigns))
    .groupBy(campaigns.id)
    .orderBy(desc(campaigns.createdAt))
    .limit(50);

  const t = leadTotals;
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    totals: { ...t },
    rates: {
      deliveryRate: rate(t.delivered, t.sent),
      bounceRate: rate(t.bounced, t.sent),
      complaintRate: rate(t.complained, t.sent),
      openRate: rate(t.opened, t.delivered),
      clickRate: rate(t.clicked, t.delivered),
      replyRate: rate(t.replied, t.sent),
    },
    byCampaign: byCampaignRows,
  };
}

export async function timeseries(ctx: AppContext, o: RangeOpts): Promise<TimeseriesPoint[]> {
  const { from, to } = range(o);
  const day = (col: unknown) => sql<string>`to_char(date_trunc('day', ${col}), 'YYYY-MM-DD')`;
  const points = new Map<string, TimeseriesPoint>();
  const get = (d: string) => {
    let p = points.get(d);
    if (!p) {
      p = { date: d, sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, replied: 0 };
      points.set(d, p);
    }
    return p;
  };

  const sentRows = await ctx.db
    .select({ d: day(emails.sentAt), n: sql<number>`count(*)::int` })
    .from(emails)
    .where(and(eq(emails.direction, "outbound"), gte(emails.sentAt, from), lte(emails.sentAt, to), campaignScope(o, emails)))
    .groupBy(sql`1`);
  for (const r of sentRows) get(r.d).sent = r.n;

  const evRows = await ctx.db
    .select({ d: day(emailEvents.occurredAt), type: emailEvents.eventType, n: sql<number>`count(distinct ${emailEvents.sesMessageId})::int` })
    .from(emailEvents)
    .where(and(gte(emailEvents.occurredAt, from), lte(emailEvents.occurredAt, to), campaignScope(o, emailEvents)))
    .groupBy(sql`1`, emailEvents.eventType);
  for (const r of evRows) {
    const p = get(r.d);
    if (r.type === "Delivery") p.delivered = r.n;
    else if (r.type === "Bounce") p.bounced = r.n;
    else if (r.type === "Complaint") p.complained = r.n;
    else if (r.type === "Open") p.opened = r.n;
    else if (r.type === "Click") p.clicked = r.n;
  }

  const replyRows = await ctx.db
    .select({ d: day(leads.repliedAt), n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(gte(leads.repliedAt, from), lte(leads.repliedAt, to), campaignScope(o, leads)))
    .groupBy(sql`1`);
  for (const r of replyRows) get(r.d).replied = r.n;

  // Fill missing days so charts are continuous.
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86_400_000)) get(d.toISOString().slice(0, 10));
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function campaignTimeseries(ctx: AppContext, o: { campaignId: string }): Promise<TimeseriesPoint[]> {
  const [c] = await ctx.db.select({ createdAt: campaigns.createdAt }).from(campaigns).where(eq(campaigns.id, o.campaignId)).limit(1);
  return timeseries(ctx, { campaignId: o.campaignId, from: c?.createdAt, to: new Date() });
}

export async function llmUsage(ctx: AppContext, o: RangeOpts) {
  const { from, to } = range(o);
  const [row] = await ctx.db
    .select({
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}),0)::int`,
      outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}),0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum(${llmCalls.cacheReadTokens}),0)::int`,
      failures: sql<number>`count(*) filter (where ${llmCalls.ok} = false)::int`,
      avgLatencyMs: sql<number>`coalesce(avg(${llmCalls.durationMs}),0)::int`,
    })
    .from(llmCalls)
    .where(and(gte(llmCalls.createdAt, from), lte(llmCalls.createdAt, to), campaignScope(o, llmCalls)));
  return row;
}
