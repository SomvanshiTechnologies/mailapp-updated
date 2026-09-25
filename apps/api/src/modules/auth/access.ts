import { and, eq, inArray, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { CampaignAccessLevel, UserRole } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaignAccess, campaigns, emails, leads, users, type CampaignRow } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";

/**
 * Campaign-level authorisation.
 *
 *  - admins have full access to every campaign
 *  - the creator of a campaign has full access to it
 *  - anyone else needs a grant in campaign_access (view < edit < full), capped by their role:
 *    viewers can never exceed "view", operators can hold any level
 *  - "none" means the campaign is invisible to the caller
 */
export type EffectiveAccess = CampaignAccessLevel | "none";

const LEVEL_RANK: Record<EffectiveAccess, number> = { none: 0, view: 1, edit: 2, full: 3 };

export function accessAtLeast(level: EffectiveAccess, min: CampaignAccessLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

function capByRole(level: EffectiveAccess, role: UserRole): EffectiveAccess {
  if (role === "viewer" && LEVEL_RANK[level] > LEVEL_RANK.view) return "view";
  return level;
}

export interface Principal {
  sub: string;
  role: UserRole;
}

export function principalOf(req: FastifyRequest): Principal {
  if (!req.user) throw AppError.unauthorized();
  return { sub: req.user.sub, role: req.user.role };
}

/** Effective access of a principal to one campaign row (no extra query for admins/owners). */
export async function campaignAccessFor(ctx: AppContext, who: Principal, campaign: Pick<CampaignRow, "id" | "createdBy">): Promise<EffectiveAccess> {
  if (who.role === "admin") return "full";
  if (campaign.createdBy && campaign.createdBy === who.sub) return capByRole("full", who.role);
  const [grant] = await ctx.db
    .select({ level: campaignAccess.level })
    .from(campaignAccess)
    .where(and(eq(campaignAccess.campaignId, campaign.id), eq(campaignAccess.userId, who.sub)))
    .limit(1);
  return capByRole(grant?.level ?? "none", who.role);
}

/** Effective access for many campaigns at once (list endpoints). */
export async function campaignAccessMap(ctx: AppContext, who: Principal, rows: Array<Pick<CampaignRow, "id" | "createdBy">>): Promise<Map<string, EffectiveAccess>> {
  const map = new Map<string, EffectiveAccess>();
  if (who.role === "admin") {
    for (const r of rows) map.set(r.id, "full");
    return map;
  }
  const ids = rows.map((r) => r.id);
  const grants = ids.length
    ? await ctx.db
        .select({ campaignId: campaignAccess.campaignId, level: campaignAccess.level })
        .from(campaignAccess)
        .where(and(eq(campaignAccess.userId, who.sub), inArray(campaignAccess.campaignId, ids)))
    : [];
  const byId = new Map(grants.map((g) => [g.campaignId, g.level]));
  for (const r of rows) {
    const level: EffectiveAccess = r.createdBy === who.sub ? "full" : (byId.get(r.id) ?? "none");
    map.set(r.id, capByRole(level, who.role));
  }
  return map;
}

/** Load a campaign and check the caller holds at least `min` access. */
export async function requireCampaignAccess(ctx: AppContext, req: FastifyRequest, campaignId: string, min: CampaignAccessLevel): Promise<{ campaign: CampaignRow; access: EffectiveAccess }> {
  const [campaign] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) throw AppError.notFound("Campaign");
  const who = principalOf(req);
  const access = await campaignAccessFor(ctx, who, campaign);
  // Hide campaigns the caller cannot see at all; otherwise a clear 403.
  if (access === "none") throw AppError.notFound("Campaign");
  if (!accessAtLeast(access, min)) throw AppError.forbidden(`This action needs "${min}" access to the campaign`);
  return { campaign, access };
}

export async function requireLeadAccess(ctx: AppContext, req: FastifyRequest, leadId: string, min: CampaignAccessLevel) {
  const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) throw AppError.notFound("Lead");
  const { campaign, access } = await requireCampaignAccess(ctx, req, lead.campaignId, min);
  return { lead, campaign, access };
}

export async function requireEmailAccess(ctx: AppContext, req: FastifyRequest, emailId: string, min: CampaignAccessLevel) {
  const [email] = await ctx.db.select().from(emails).where(eq(emails.id, emailId)).limit(1);
  if (!email) throw AppError.notFound("Email");
  const { campaign, access } = await requireCampaignAccess(ctx, req, email.campaignId, min);
  return { email, campaign, access };
}

/**
 * Ids of every campaign the caller may see, or null for "no restriction" (admins, and users
 * whose dashboard scope is "all"). Used to scope lists and analytics.
 */
export async function visibleCampaignIds(ctx: AppContext, who: Principal, opts: { forDashboard?: boolean } = {}): Promise<string[] | null> {
  if (who.role === "admin") return null;
  if (opts.forDashboard) {
    const [u] = await ctx.db.select({ scope: users.dashboardScope }).from(users).where(eq(users.id, who.sub)).limit(1);
    if (u?.scope === "all") return null;
  }
  const rows = await ctx.db
    .select({ id: campaigns.id })
    .from(campaigns)
    .leftJoin(campaignAccess, and(eq(campaignAccess.campaignId, campaigns.id), eq(campaignAccess.userId, who.sub)))
    .where(or(eq(campaigns.createdBy, who.sub), eq(campaignAccess.userId, who.sub)));
  return [...new Set(rows.map((r) => r.id))];
}
