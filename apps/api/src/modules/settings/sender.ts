import { eq } from "drizzle-orm";
import type { AppContext } from "../../context.js";
import { users, type CampaignRow } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";

export interface ResolvedSender {
  fromEmail: string;
  fromName: string;
  replyTo: string;
  postalAddress: string;
  /** The user whose identity is used (campaign owner), if any. */
  ownerId: string | null;
}

/**
 * Reply-To on the SES inbound domain for a given sender, e.g. "priya@reply.example.com" for
 * "priya@example.com". Replies to it are received by SES and posted to the app. Empty when no
 * inbound domain is configured.
 */
export function inboundReplyAddress(config: { SES_INBOUND_DOMAIN: string }, fromEmail: string): string {
  const domain = config.SES_INBOUND_DOMAIN.trim().toLowerCase();
  if (!domain) return "";
  const local = (fromEmail.split("@")[0] || "replies").toLowerCase().replace(/[^a-z0-9._+-]/g, "");
  return `${local || "replies"}@${domain}`;
}

/**
 * Sender identity precedence: campaign override → campaign owner's personal profile →
 * organisation settings. The owner is the user who created the campaign.
 *
 * Reply-To has one extra rung: when an SES inbound domain is configured and neither the
 * campaign nor the owner set an explicit Reply-To, replies are routed through that domain so
 * the app captures them (and forwards them to the owner's mailbox, see inbound.ts).
 */
export async function resolveSender(ctx: AppContext, campaign: Pick<CampaignRow, "createdBy" | "fromEmail" | "fromName" | "replyTo">): Promise<ResolvedSender> {
  const settings = await ctx.settings.get();
  const owner = campaign.createdBy
    ? (await ctx.db.select().from(users).where(eq(users.id, campaign.createdBy)).limit(1))[0] ?? null
    : null;
  const pick = (...vals: Array<string | null | undefined>) => vals.find((v) => v && v.trim()) ?? "";
  const fromEmail = pick(campaign.fromEmail, owner?.fromEmail, settings.fromEmail);
  return {
    fromEmail,
    fromName: pick(campaign.fromName, owner?.fromName, settings.fromName),
    replyTo: pick(campaign.replyTo, owner?.replyTo, inboundReplyAddress(ctx.config, fromEmail), settings.replyTo),
    postalAddress: pick(owner?.postalAddress, settings.postalAddress),
    ownerId: owner?.id ?? null,
  };
}

/**
 * Sending from an address SES has not verified fails at send time with MessageRejected, so
 * we check when a sender address is saved. An address is allowed when it, or its domain, is a
 * verified SES identity (the mock gateway treats the configured from-address and its domain
 * as verified).
 */
export async function assertSenderVerified(ctx: AppContext, email: string): Promise<void> {
  if (!email) return;
  const identities = await ctx.ses.listIdentities();
  if (identities === null) return; // could not check (permissions/network): do not block the save
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1] ?? "";
  const ok = identities.some((i) => {
    const name = i.name.toLowerCase();
    if (!i.verified) return false;
    return i.type === "EMAIL_ADDRESS" ? name === lower : domain === name || domain.endsWith(`.${name}`);
  });
  if (!ok) {
    throw AppError.badRequest(
      `"${email}" is not a verified SES identity. Either verify the address in SES, or use an address on a verified domain (${
        identities.filter((i) => i.type === "DOMAIN" && i.verified).map((i) => i.name).join(", ") || "none verified"
      }).`,
    );
  }
}
