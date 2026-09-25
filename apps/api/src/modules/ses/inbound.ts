import { and, desc, eq, gt, inArray, like, or } from "drizzle-orm";
import { simpleParser, type ParsedMail } from "mailparser";
import type { AppContext } from "../../context.js";
import { campaigns, emails, files, inboundMessages, leads, type EmailRow, type LeadRow } from "../../db/schema.js";
import { resolveSender } from "../settings/sender.js";

/**
 * A reply that arrived through the SES inbound domain is only visible inside the app, so copy
 * it to the campaign owner's real mailbox. Reply-To is the lead, so the owner can answer
 * straight from their mail client. Failures are logged, never fatal.
 */
export async function forwardReplyToOwner(ctx: AppContext, lead: LeadRow, parsed: ParsedInbound): Promise<boolean> {
  const settings = await ctx.settings.get();
  if (!settings.forwardRepliesToOwner) return false;
  const [campaign] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, lead.campaignId)).limit(1);
  if (!campaign) return false;
  const sender = await resolveSender(ctx, campaign);
  if (!sender.fromEmail) return false;
  const who = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || parsed.from || "a lead";
  const leadUrl = `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, "")}/leads/${lead.id}`;
  const text = [
    `${who}${lead.company ? ` (${lead.company})` : ""} replied to your campaign "${campaign.name}".`,
    `Reply to this message to answer them directly. Lead page: ${leadUrl}`,
    "",
    "----- Original message -----",
    `From: ${parsed.from ?? "unknown"}`,
    `Subject: ${parsed.subject}`,
    "",
    parsed.text,
  ].join("\n");
  try {
    await ctx.ses.send({
      from: settings.fromEmail,
      fromName: "Outreach replies",
      to: sender.fromEmail,
      replyTo: parsed.from ?? undefined,
      subject: parsed.subject.toLowerCase().startsWith("re:") ? parsed.subject : `Re: ${parsed.subject}`,
      text,
      html: null,
      headers: parsed.messageId ? { "In-Reply-To": parsed.messageId, References: [...parsed.references, parsed.messageId].join(" ") } : {},
      tags: { kind: "reply_forward", lead_id: lead.id },
    });
    ctx.metrics.emit("replies_forwarded");
    return true;
  } catch (err) {
    ctx.logger.warn({ err, leadId: lead.id }, "forwarding reply to owner failed");
    return false;
  }
}

export interface SesInboundNotification {
  notificationType?: string; // "Received"
  mail?: { messageId?: string; source?: string; destination?: string[]; timestamp?: string; commonHeaders?: { subject?: string; from?: string[] } };
  receipt?: { action?: { type?: string; bucketName?: string; objectKey?: string }; spamVerdict?: { status?: string }; virusVerdict?: { status?: string } };
  content?: string; // base64 when the action type is SNS
}

export interface ParsedInbound {
  externalId: string;
  from: string | null;
  to: string | null;
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  isAutoReply: boolean;
  receivedAt: Date;
}

export interface InboundResult {
  stored: boolean;
  duplicate: boolean;
  matched: boolean;
  leadId: string | null;
  method: string | null;
  autoReply: boolean;
}

const AUTO_SUBJECT = /\b(out of (the )?office|automatic reply|auto-?reply|autoreply|away from (my )?(email|office)|on leave|vacation)\b/i;

export function parsedMailToInbound(mail: ParsedMail, externalId: string): ParsedInbound {
  const headers = mail.headers;
  const h = (name: string) => {
    const v = headers.get(name);
    return v === undefined ? null : typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : String((v as { text?: string }).text ?? v);
  };
  const autoSubmitted = (h("auto-submitted") ?? "").toLowerCase();
  const precedence = (h("precedence") ?? "").toLowerCase();
  const isAutoReply =
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    h("x-autoreply") !== null ||
    h("x-autorespond") !== null ||
    h("x-auto-response-suppress") !== null ||
    precedence === "auto_reply" ||
    precedence === "bulk" ||
    AUTO_SUBJECT.test(mail.subject ?? "");
  const refs = mail.references ? (Array.isArray(mail.references) ? mail.references : [mail.references]) : [];
  const fromAddr = mail.from?.value?.[0]?.address ?? null;
  const toAddr = (Array.isArray(mail.to) ? mail.to[0] : mail.to)?.value?.[0]?.address ?? null;
  return {
    externalId,
    from: fromAddr ? fromAddr.toLowerCase() : null,
    to: toAddr ? toAddr.toLowerCase() : null,
    subject: mail.subject ?? "",
    text: (mail.text ?? (typeof mail.html === "string" ? mail.html.replace(/<[^>]+>/g, " ") : "")).trim().slice(0, 50_000),
    messageId: mail.messageId ?? null,
    inReplyTo: mail.inReplyTo ?? null,
    references: refs,
    isAutoReply,
    receivedAt: mail.date ?? new Date(),
  };
}

function idPart(msgId: string): string {
  return msgId.replace(/^<|>$/g, "").split("@")[0];
}

/** Find the outbound email a reply refers to. */
export async function matchInbound(ctx: AppContext, parsed: ParsedInbound): Promise<{ email: EmailRow | null; lead: LeadRow | null; method: string | null }> {
  const candidates = [parsed.inReplyTo, ...parsed.references].filter((x): x is string => !!x);
  for (const cand of candidates) {
    const id = idPart(cand);
    const [email] = await ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.direction, "outbound"), or(eq(emails.sesMessageId, id), like(emails.messageIdHeader, `<${id}@%`), eq(emails.messageIdHeader, cand))))
      .limit(1);
    if (email) {
      const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, email.leadId)).limit(1);
      return { email, lead: lead ?? null, method: "message-id" };
    }
  }
  if (parsed.from) {
    // Fallback: sender address matches a lead we emailed in the last 90 days.
    const since = new Date(Date.now() - 90 * 86_400_000);
    const rows = await ctx.db
      .select({ lead: leads, email: emails })
      .from(emails)
      .innerJoin(leads, eq(emails.leadId, leads.id))
      .where(and(eq(leads.email, parsed.from), eq(emails.direction, "outbound"), inArray(emails.status, ["sent", "delivered"]), gt(emails.sentAt, since)))
      .orderBy(desc(emails.sentAt))
      .limit(1);
    if (rows[0]) return { email: rows[0].email, lead: rows[0].lead, method: "sender-address" };
  }
  return { email: null, lead: null, method: null };
}

/** Store the inbound message, link it to a lead, and stop the sequence on a real reply. */
export async function recordInbound(ctx: AppContext, source: "ses" | "imap" | "manual", parsed: ParsedInbound, rawFileId: string | null = null): Promise<InboundResult> {
  const { email, lead, method } = await matchInbound(ctx, parsed);
  const inserted = await ctx.db
    .insert(inboundMessages)
    .values({
      source,
      externalId: parsed.externalId,
      fromEmail: parsed.from,
      toEmail: parsed.to,
      subject: parsed.subject,
      bodyText: parsed.text,
      messageIdHeader: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      referencesHeader: parsed.references.join(" ") || null,
      matchedLeadId: lead?.id,
      matchedEmailId: email?.id,
      matchMethod: method,
      isAutoReply: parsed.isAutoReply,
      rawFileId,
      receivedAt: parsed.receivedAt,
    })
    .onConflictDoNothing({ target: [inboundMessages.source, inboundMessages.externalId] })
    .returning({ id: inboundMessages.id });
  if (!inserted.length) return { stored: false, duplicate: true, matched: !!lead, leadId: lead?.id ?? null, method, autoReply: parsed.isAutoReply };
  if (!lead || !email) {
    ctx.logger.info({ from: parsed.from, subject: parsed.subject }, "inbound message did not match any lead");
    return { stored: true, duplicate: false, matched: false, leadId: null, method: null, autoReply: parsed.isAutoReply };
  }
  await ctx.db.insert(emails).values({
    leadId: lead.id,
    campaignId: lead.campaignId,
    step: email.step,
    direction: "inbound",
    status: "delivered",
    fromEmail: parsed.from,
    toEmail: parsed.to ?? email.fromEmail ?? "",
    subject: parsed.subject,
    bodyText: parsed.text,
    messageIdHeader: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    referencesHeader: parsed.references.join(" ") || null,
    sentAt: parsed.receivedAt,
    llmMeta: { autoReply: parsed.isAutoReply, matchMethod: method },
  });
  if (!parsed.isAutoReply) {
    const terminal = ["bounced", "complained", "unsubscribed"];
    if (!terminal.includes(lead.status)) {
      await ctx.db
        .update(leads)
        .set({ status: "replied", repliedAt: lead.repliedAt ?? parsed.receivedAt, nextActionAt: null, updatedAt: new Date() })
        .where(eq(leads.id, lead.id));
      // Cancel any pending drafts/approved follow-ups.
      await ctx.db
        .update(emails)
        .set({ status: "rejected", reviewNote: "lead replied", updatedAt: new Date() })
        .where(and(eq(emails.leadId, lead.id), inArray(emails.status, ["draft", "pending_review", "approved", "queued"])));
      ctx.metrics.emit("replies", 1, { source });
    }
    // IMAP replies already sit in the owner's mailbox; SES-received ones do not.
    if (source === "ses") await forwardReplyToOwner(ctx, lead, parsed);
  }
  return { stored: true, duplicate: false, matched: true, leadId: lead.id, method, autoReply: parsed.isAutoReply };
}

/** Handle an SES receipt-rule notification (S3 action or inline SNS content). */
export async function processInboundNotification(ctx: AppContext, n: SesInboundNotification): Promise<InboundResult> {
  const externalId = n.mail?.messageId ?? `${Date.now()}`;
  const spam = n.receipt?.spamVerdict?.status;
  const virus = n.receipt?.virusVerdict?.status;
  if (spam === "FAIL" || virus === "FAIL") {
    ctx.logger.warn({ externalId, spam, virus }, "inbound rejected by SES verdicts");
    return { stored: false, duplicate: false, matched: false, leadId: null, method: null, autoReply: false };
  }
  let raw: Buffer;
  let rawFileId: string | null = null;
  if (n.content) {
    raw = Buffer.from(n.content, "base64");
  } else if (n.receipt?.action?.type === "S3" && n.receipt.action.bucketName && n.receipt.action.objectKey) {
    raw = await ctx.storage.getFromBucket(n.receipt.action.bucketName, n.receipt.action.objectKey);
    const [f] = await ctx.db
      .insert(files)
      .values({ kind: "inbound_raw", storage: "s3", key: `${n.receipt.action.bucketName}/${n.receipt.action.objectKey}`, originalName: externalId, mimeType: "message/rfc822", sizeBytes: raw.length })
      .returning();
    rawFileId = f.id;
  } else {
    ctx.logger.warn({ externalId }, "inbound notification has no content or S3 action");
    return { stored: false, duplicate: false, matched: false, leadId: null, method: null, autoReply: false };
  }
  const mail = await simpleParser(raw);
  const parsed = parsedMailToInbound(mail, externalId);
  return recordInbound(ctx, "ses", parsed, rawFileId);
}
