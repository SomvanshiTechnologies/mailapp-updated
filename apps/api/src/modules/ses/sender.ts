import { and, desc, eq, sql } from "drizzle-orm";
import { JOB_QUEUES, TERMINAL_LEAD_STATUSES } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, dailySendCounters, emails, leads, sendAttempts, sesSnapshots } from "../../db/schema.js";
import { errorToRecord } from "../../lib/errors.js";
import { addDays, nextSendWindow, utcDay } from "../../lib/time.js";
import type { SendJob } from "../../jobs/types.js";
import { loadInstructionBundle } from "../instructions/service.js";
import { renderEmail } from "../pipeline/render.js";
import { resolveSender } from "../settings/sender.js";
import { isSuppressed } from "../suppressions/service.js";
import { TokenBucket } from "./rate-limiter.js";

const bucket = new TokenBucket(1);

/** Message-ID header SES assigns for a given message id (region-dependent domain). */
export function sesMessageIdHeader(messageId: string, region: string): string {
  const domain = region === "us-east-1" ? "email.amazonses.com" : `${region}.amazonses.com`;
  return `<${messageId}@${domain}>`;
}

const PERMANENT_ERRORS = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "BadRequestException",
  "NotFoundException",
  "SendingPausedException",
]);

/**
 * Increment today's counter if under the cap. Returns the new count or null when the cap is hit.
 */
export async function reserveDailySlot(ctx: AppContext, cap: number): Promise<number | null> {
  const day = utcDay();
  if (cap <= 0) return 0; // 0 = unlimited
  const rows = await ctx.db
    .insert(dailySendCounters)
    .values({ day, count: 1 })
    .onConflictDoUpdate({
      target: dailySendCounters.day,
      set: { count: sql`${dailySendCounters.count} + 1`, updatedAt: new Date() },
      setWhere: sql`${dailySendCounters.count} < ${cap}`,
    })
    .returning({ count: dailySendCounters.count });
  return rows[0]?.count ?? null;
}

export async function runSendJob(ctx: AppContext, job: SendJob): Promise<void> {
  const log = ctx.logger.child({ job: "send", emailId: job.emailId });
  const [email] = await ctx.db.select().from(emails).where(eq(emails.id, job.emailId)).limit(1);
  if (!email) return log.warn("email not found");
  if (!["approved", "queued", "sending"].includes(email.status)) return log.info({ status: email.status }, "email not sendable, skipping");
  const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, email.leadId)).limit(1);
  const [campaign] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, email.campaignId)).limit(1);
  if (!lead || !campaign) return log.warn("lead/campaign missing");
  if (TERMINAL_LEAD_STATUSES.has(lead.status)) {
    await ctx.db.update(emails).set({ status: "rejected", reviewNote: `lead ${lead.status}`, updatedAt: new Date() }).where(eq(emails.id, email.id));
    return log.info({ status: lead.status }, "lead terminal, cancelled send");
  }
  if (campaign.status !== "active") return log.info({ status: campaign.status }, "campaign not active; leaving email approved");

  const settings = await ctx.settings.get();
  const rules = await ctx.settings.effectiveHardRules(campaign.hardRulesOverride);

  // Suppression re-check (address may have bounced in another campaign since drafting).
  if (await isSuppressed(ctx, lead.email)) {
    await ctx.db.transaction(async (tx) => {
      await tx.update(emails).set({ status: "rejected", reviewNote: "suppressed", updatedAt: new Date() }).where(eq(emails.id, email.id));
      await tx.update(leads).set({ status: "suppressed", nextActionAt: null, updatedAt: new Date() }).where(eq(leads.id, lead.id));
    });
    return log.info("recipient suppressed, cancelled");
  }

  // Send window.
  const win = nextSendWindow(new Date(), rules);
  if (!win.inWindow) {
    await ctx.db.transaction(async (tx) => {
      await tx.update(emails).set({ status: "queued", scheduledFor: win.next, updatedAt: new Date() }).where(eq(emails.id, email.id));
      await tx.update(leads).set({ status: "scheduled", updatedAt: new Date() }).where(eq(leads.id, lead.id));
    });
    await ctx.queue.publish<SendJob>(JOB_QUEUES.send, { emailId: email.id }, { startAfter: win.next, singletonKey: `send:${email.id}:${win.next.getTime()}` });
    return log.info({ next: win.next }, "outside send window, rescheduled");
  }

  // Daily cap (settings cap and SES quota, whichever is lower).
  let cap = settings.dailyCap;
  const [snap] = await ctx.db.select().from(sesSnapshots).where(eq(sesSnapshots.kind, "account")).orderBy(desc(sesSnapshots.fetchedAt)).limit(1);
  const quota = (snap?.data as { sendQuota?: { max24HourSend?: number; maxSendRate?: number } } | undefined)?.sendQuota;
  if (quota?.max24HourSend && quota.max24HourSend > 0) cap = cap > 0 ? Math.min(cap, quota.max24HourSend) : quota.max24HourSend;
  const slot = await reserveDailySlot(ctx, cap);
  if (slot === null) {
    const tomorrow = new Date(`${utcDay(addDays(new Date(), 1))}T00:05:00Z`);
    await ctx.db.transaction(async (tx) => {
      await tx.update(emails).set({ status: "queued", scheduledFor: tomorrow, updatedAt: new Date() }).where(eq(emails.id, email.id));
      await tx.update(leads).set({ status: "scheduled", updatedAt: new Date() }).where(eq(leads.id, lead.id));
    });
    await ctx.queue.publish<SendJob>(JOB_QUEUES.send, { emailId: email.id }, { startAfter: tomorrow, singletonKey: `send:${email.id}:${tomorrow.getTime()}` });
    ctx.metrics.emit("send_rate_limited", 1, { reason: "daily_cap" });
    return log.warn({ cap }, "daily cap reached, rescheduled to tomorrow");
  }

  // Per-second rate.
  const rate = Math.min(settings.maxSendRate, quota?.maxSendRate && quota.maxSendRate > 0 ? quota.maxSendRate : settings.maxSendRate);
  bucket.setRate(rate);
  await bucket.acquire();

  await ctx.db.transaction(async (tx) => {
    await tx.update(emails).set({ status: "sending", updatedAt: new Date() }).where(eq(emails.id, email.id));
    await tx.update(leads).set({ status: "sending", updatedAt: new Date() }).where(eq(leads.id, lead.id));
  });

  // Sender identity and instructions come from the campaign owner's profile, falling back to
  // the organisation settings.
  const sender = await resolveSender(ctx, campaign);
  const bundle = await loadInstructionBundle(ctx.db, sender.ownerId);
  const unsubscribeUrl = `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, "")}/u/${lead.unsubscribeToken}`;
  const senderName = sender.fromName;
  const rendered = renderEmail({
    bodyText: email.bodyText,
    signature: bundle.signature,
    senderName,
    unsubscribeUrl,
    postalAddress: sender.postalAddress,
    includeUnsubscribeFooter: rules.requireUnsubscribeFooter,
    linkLabel: settings.landingPage.emailLinkLabel,
    deliveryMode: settings.deliveryMode,
    htmlPart: settings.trackOpens,
  });

  // Delivery-mode headers (List-Unsubscribe only in bulk mode), then threading for follow-ups:
  // reference the most recent sent outbound email.
  const headers: Record<string, string> = { ...rendered.headers };
  let inReplyTo: string | null = null;
  let references: string | null = null;
  const step = campaign.sequence.find((s) => s.step === email.step);
  if (email.step > 1 && step?.threaded) {
    const [prev] = await ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.leadId, lead.id), eq(emails.direction, "outbound"), eq(emails.status, "sent")))
      .orderBy(desc(emails.sentAt))
      .limit(1);
    const prevHeader = prev?.messageIdHeader ?? null;
    if (prevHeader) {
      inReplyTo = prevHeader;
      references = [prev?.referencesHeader, prevHeader].filter(Boolean).join(" ");
      headers["In-Reply-To"] = inReplyTo;
      headers["References"] = references;
    }
  }

  const fromEmail = sender.fromEmail;
  const replyTo = sender.replyTo;
  const configurationSet = settings.configurationSet || ctx.config.SES_CONFIGURATION_SET || undefined;
  const input = {
    from: fromEmail,
    fromName: senderName,
    to: lead.email,
    replyTo: replyTo || undefined,
    subject: email.subject,
    text: rendered.text,
    html: rendered.html,
    headers,
    tags: { campaign_id: campaign.id, lead_id: lead.id, email_id: email.id, step: String(email.step) },
    configurationSet,
  };

  const attemptNo = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(sendAttempts).where(eq(sendAttempts.emailId, email.id)))[0].n + 1;
  const started = Date.now();
  try {
    const result = await ctx.ses.send(input);
    const durationMs = Date.now() - started;
    const messageIdHeader = sesMessageIdHeader(result.messageId, ctx.config.AWS_REGION);
    const now = new Date();
    const nextStep = campaign.sequence.find((s) => s.step === email.step + 1);
    const nextActionAt = nextStep ? addDays(now, nextStep.delayDays) : null;
    await ctx.db.transaction(async (tx) => {
      await tx.insert(sendAttempts).values({ emailId: email.id, attemptNo, request: input2summary(input), response: result.raw, durationMs });
      await tx
        .update(emails)
        .set({
          status: "sent",
          sentAt: now,
          sesMessageId: result.messageId,
          messageIdHeader,
          inReplyTo,
          referencesHeader: references,
          bodyHtml: rendered.html,
          fromEmail,
          senderUserId: sender.ownerId,
          rawSendResponse: result.raw,
          error: null,
          updatedAt: now,
        })
        .where(eq(emails.id, email.id));
      await tx
        .update(leads)
        .set({
          status: "sent",
          sentAt: lead.sentAt ?? now,
          currentStep: email.step,
          nextActionAt,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(leads.id, lead.id));
    });
    ctx.metrics.emit("emails_sent", 1, { campaign: campaign.id, step: String(email.step) });
    log.info({ messageId: result.messageId, durationMs, nextActionAt }, "email sent");
  } catch (err) {
    const durationMs = Date.now() - started;
    const rec = errorToRecord(err);
    const name = String(rec.name ?? "");
    const permanent = PERMANENT_ERRORS.has(name) || (typeof rec.status === "number" && rec.status >= 400 && rec.status < 500 && rec.status !== 429);
    await ctx.db.transaction(async (tx) => {
      await tx.insert(sendAttempts).values({ emailId: email.id, attemptNo, request: input2summary(input), error: rec, durationMs });
      await tx
        .update(emails)
        .set({ status: permanent ? "failed" : "approved", error: `${name}: ${rec.message}`.slice(0, 2000), updatedAt: new Date() })
        .where(eq(emails.id, email.id));
      await tx
        .update(leads)
        .set({ status: permanent ? "failed" : "approved", lastError: `send: ${name}: ${rec.message}`.slice(0, 2000), updatedAt: new Date() })
        .where(eq(leads.id, lead.id));
    });
    ctx.metrics.emit("send_failures", 1, { permanent: String(permanent), error: name || "unknown" });
    log.error({ err, permanent, attemptNo }, "send failed");
    if (!permanent) throw err; // let pg-boss retry with backoff
  }
}

function input2summary(input: Parameters<AppContext["ses"]["send"]>[0]): Record<string, unknown> {
  return {
    from: input.fromName ? `${input.fromName} <${input.from}>` : input.from,
    to: input.to,
    replyTo: input.replyTo,
    subject: input.subject,
    headers: input.headers,
    tags: input.tags,
    configurationSet: input.configurationSet,
    textLength: input.text.length,
    htmlLength: input.html?.length ?? 0,
  };
}
