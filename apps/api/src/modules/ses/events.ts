import { eq, or, like } from "drizzle-orm";
import { SES_EVENT_TYPES, type SesEventType } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { emailEvents, emails, leads, type EmailRow, type LeadRow } from "../../db/schema.js";
import { addSuppression } from "../suppressions/service.js";

export interface SesEventPayload {
  eventType?: string;
  notificationType?: string; // legacy SNS notification style
  mail?: { messageId?: string; timestamp?: string; destination?: string[]; tags?: Record<string, string[]> };
  bounce?: { bounceType?: string; bounceSubType?: string; timestamp?: string; bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string }> };
  complaint?: { complaintFeedbackType?: string; timestamp?: string; complainedRecipients?: Array<{ emailAddress?: string }> };
  delivery?: { timestamp?: string; smtpResponse?: string };
  reject?: { reason?: string };
  open?: { timestamp?: string; userAgent?: string; ipAddress?: string };
  click?: { timestamp?: string; link?: string; userAgent?: string };
  deliveryDelay?: { timestamp?: string; delayType?: string };
  failure?: { errorMessage?: string; templateName?: string };
  subscription?: { timestamp?: string; source?: string };
  [k: string]: unknown;
}

export interface ProcessResult {
  stored: boolean;
  duplicate: boolean;
  matched: boolean;
  eventType: SesEventType | null;
}

const RANK: Record<string, number> = { sent: 1, delivered: 2, opened: 3, clicked: 4 };

function eventTimestamp(p: SesEventPayload, type: SesEventType): Date {
  const ts =
    (type === "Bounce" && p.bounce?.timestamp) ||
    (type === "Complaint" && p.complaint?.timestamp) ||
    (type === "Delivery" && p.delivery?.timestamp) ||
    (type === "Open" && p.open?.timestamp) ||
    (type === "Click" && p.click?.timestamp) ||
    (type === "DeliveryDelay" && p.deliveryDelay?.timestamp) ||
    (type === "Subscription" && p.subscription?.timestamp) ||
    p.mail?.timestamp;
  const d = ts ? new Date(ts) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export function normaliseEventType(p: SesEventPayload): SesEventType | null {
  const raw = (p.eventType ?? p.notificationType ?? "").toString();
  const found = SES_EVENT_TYPES.find((t) => t.toLowerCase() === raw.toLowerCase());
  return found ?? null;
}

/** Store and apply one SES event. Idempotent via dedupe key. */
export async function processSesEvent(ctx: AppContext, payload: SesEventPayload): Promise<ProcessResult> {
  const eventType = normaliseEventType(payload);
  const messageId = payload.mail?.messageId;
  if (!eventType || !messageId) {
    ctx.logger.warn({ eventType: payload.eventType, notificationType: payload.notificationType }, "unrecognised SES event");
    return { stored: false, duplicate: false, matched: false, eventType: null };
  }
  const occurredAt = eventTimestamp(payload, eventType);
  const subType =
    (eventType === "Bounce" && `${payload.bounce?.bounceType ?? ""}/${payload.bounce?.bounceSubType ?? ""}`) ||
    (eventType === "Complaint" && (payload.complaint?.complaintFeedbackType ?? "")) ||
    (eventType === "DeliveryDelay" && (payload.deliveryDelay?.delayType ?? "")) ||
    (eventType === "Reject" && (payload.reject?.reason ?? "")) ||
    null;
  const dedupeKey = `${eventType}:${messageId}:${occurredAt.toISOString()}`;

  const [email] = await ctx.db
    .select()
    .from(emails)
    .where(or(eq(emails.sesMessageId, messageId), like(emails.messageIdHeader, `<${messageId}@%`)))
    .limit(1);
  const lead = email ? (await ctx.db.select().from(leads).where(eq(leads.id, email.leadId)).limit(1))[0] : undefined;

  const inserted = await ctx.db
    .insert(emailEvents)
    .values({
      emailId: email?.id,
      leadId: lead?.id,
      campaignId: email?.campaignId,
      sesMessageId: messageId,
      eventType,
      subType: subType || null,
      dedupeKey,
      payload: payload as Record<string, unknown>,
      occurredAt,
    })
    .onConflictDoNothing({ target: emailEvents.dedupeKey })
    .returning({ id: emailEvents.id });
  if (!inserted.length) return { stored: false, duplicate: true, matched: !!email, eventType };
  ctx.metrics.emit("events_ingested", 1, { type: eventType });
  if (!email || !lead) {
    ctx.logger.info({ messageId, eventType }, "event for unknown message stored");
    return { stored: true, duplicate: false, matched: false, eventType };
  }
  await applyEvent(ctx, eventType, payload, email, lead, occurredAt);
  return { stored: true, duplicate: false, matched: true, eventType };
}

async function applyEvent(ctx: AppContext, type: SesEventType, p: SesEventPayload, email: EmailRow, lead: LeadRow, at: Date): Promise<void> {
  const now = new Date();
  const upgrade = (to: "sent" | "delivered" | "opened" | "clicked") => (RANK[lead.status] ?? 0) < RANK[to] && (RANK[lead.status] ?? 0) > 0;
  switch (type) {
    case "Send":
      return;
    case "Delivery":
      await ctx.db.update(emails).set({ status: "delivered", updatedAt: now }).where(eq(emails.id, email.id));
      await ctx.db
        .update(leads)
        .set({ deliveredAt: lead.deliveredAt ?? at, status: upgrade("delivered") ? "delivered" : lead.status, updatedAt: now })
        .where(eq(leads.id, lead.id));
      return;
    case "Open":
      await ctx.db
        .update(leads)
        .set({ openedAt: lead.openedAt ?? at, status: upgrade("opened") ? "opened" : lead.status, updatedAt: now })
        .where(eq(leads.id, lead.id));
      return;
    case "Click": {
      const link = p.click?.link ?? "";
      if (link.includes("/u/")) return; // unsubscribe link clicks are handled by the unsubscribe route
      await ctx.db
        .update(leads)
        .set({ clickedAt: lead.clickedAt ?? at, status: upgrade("clicked") ? "clicked" : lead.status, updatedAt: now })
        .where(eq(leads.id, lead.id));
      return;
    }
    case "Bounce": {
      const permanent = (p.bounce?.bounceType ?? "").toLowerCase() === "permanent";
      const diag = p.bounce?.bouncedRecipients?.[0]?.diagnosticCode ?? p.bounce?.bounceSubType ?? "";
      await ctx.db.update(emails).set({ status: "bounced", error: `bounce ${p.bounce?.bounceType}/${p.bounce?.bounceSubType}: ${diag}`.slice(0, 2000), updatedAt: now }).where(eq(emails.id, email.id));
      ctx.metrics.emit("bounces", 1, { type: p.bounce?.bounceType ?? "unknown" });
      if (permanent) {
        await ctx.db
          .update(leads)
          .set({ status: "bounced", bouncedAt: at, nextActionAt: null, lastError: `hard bounce: ${diag}`.slice(0, 2000), updatedAt: now })
          .where(eq(leads.id, lead.id));
        await addSuppression(ctx, { email: lead.email, reason: "hard_bounce", source: "ses_event", note: diag.slice(0, 500) });
        await ctx.ses.putSuppressed(lead.email, "BOUNCE").catch((err) => ctx.logger.warn({ err }, "ses PutSuppressedDestination failed"));
      } else {
        await ctx.db
          .update(leads)
          .set({ lastError: `soft bounce: ${p.bounce?.bounceSubType ?? ""} ${diag}`.slice(0, 2000), updatedAt: now })
          .where(eq(leads.id, lead.id));
      }
      return;
    }
    case "Complaint":
      await ctx.db.update(emails).set({ status: "complained", updatedAt: now }).where(eq(emails.id, email.id));
      await ctx.db
        .update(leads)
        .set({ status: "complained", complainedAt: at, nextActionAt: null, updatedAt: now })
        .where(eq(leads.id, lead.id));
      await addSuppression(ctx, { email: lead.email, reason: "complaint", source: "ses_event", note: p.complaint?.complaintFeedbackType });
      await ctx.ses.putSuppressed(lead.email, "COMPLAINT").catch((err) => ctx.logger.warn({ err }, "ses PutSuppressedDestination failed"));
      ctx.metrics.emit("complaints");
      return;
    case "Reject":
    case "RenderingFailure": {
      const reason = p.reject?.reason ?? p.failure?.errorMessage ?? type;
      await ctx.db.update(emails).set({ status: "failed", error: reason, updatedAt: now }).where(eq(emails.id, email.id));
      await ctx.db.update(leads).set({ status: "failed", lastError: `${type}: ${reason}`.slice(0, 2000), nextActionAt: null, updatedAt: now }).where(eq(leads.id, lead.id));
      ctx.metrics.emit("send_failures", 1, { permanent: "true", error: type });
      return;
    }
    case "DeliveryDelay":
      await ctx.db.update(leads).set({ lastError: `delivery delayed: ${p.deliveryDelay?.delayType ?? ""}`, updatedAt: now }).where(eq(leads.id, lead.id));
      return;
    case "Subscription":
      await ctx.db
        .update(leads)
        .set({ status: "unsubscribed", unsubscribedAt: at, nextActionAt: null, updatedAt: now })
        .where(eq(leads.id, lead.id));
      await addSuppression(ctx, { email: lead.email, reason: "unsubscribe", source: "ses_subscription" });
      ctx.metrics.emit("unsubscribes", 1, { source: "ses_subscription" });
      return;
  }
}
