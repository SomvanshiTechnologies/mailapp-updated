import type { EmailDto, EmailEventDto, SendAttemptDto } from "@mailapp/shared";
import type { EmailEventRow, EmailRow, SendAttemptRow } from "../../db/schema.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toEmailDto(e: EmailRow): EmailDto {
  return {
    id: e.id,
    leadId: e.leadId,
    campaignId: e.campaignId,
    step: e.step,
    direction: e.direction,
    status: e.status,
    fromEmail: e.fromEmail,
    toEmail: e.toEmail,
    subject: e.subject,
    bodyText: e.bodyText,
    bodyHtml: e.bodyHtml,
    sesMessageId: e.sesMessageId,
    messageIdHeader: e.messageIdHeader,
    inReplyTo: e.inReplyTo,
    llmMeta: e.llmMeta ?? null,
    costMicroUsd: e.costMicroUsd,
    validation: e.validation ?? null,
    reviewedBy: e.reviewedBy,
    reviewedAt: iso(e.reviewedAt),
    reviewNote: e.reviewNote,
    scheduledFor: iso(e.scheduledFor),
    sentAt: iso(e.sentAt),
    error: e.error,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

export function toEventDto(ev: EmailEventRow): EmailEventDto {
  return {
    id: ev.id,
    emailId: ev.emailId,
    leadId: ev.leadId,
    sesMessageId: ev.sesMessageId,
    eventType: ev.eventType,
    subType: ev.subType,
    occurredAt: ev.occurredAt.toISOString(),
    receivedAt: ev.receivedAt.toISOString(),
    payload: ev.payload,
  };
}

export function toAttemptDto(a: SendAttemptRow): SendAttemptDto {
  return {
    id: a.id,
    emailId: a.emailId,
    attemptNo: a.attemptNo,
    request: a.request,
    response: a.response ?? null,
    error: a.error ?? null,
    durationMs: a.durationMs,
    createdAt: a.createdAt.toISOString(),
  };
}
