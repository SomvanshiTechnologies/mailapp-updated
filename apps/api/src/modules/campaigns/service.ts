import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  FOLLOWUP_ELIGIBLE_LEAD_STATUSES,
  JOB_QUEUES,
  TERMINAL_LEAD_STATUSES,
  type CampaignAccessLevel,
  type CampaignCounts,
  type CampaignDto,
  type CreateCampaignInput,
  type HardRules,
  type ImportSummary,
  type LeadDto,
  type LeadStatus,
} from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, emails, files, leads, suppressions, users, type CampaignRow, type LeadRow } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { makeUnsubscribeToken } from "../../lib/crypto.js";
import { nextSendWindow } from "../../lib/time.js";
import { buildLeadImport, parseSheet, type ParsedSheet } from "../excel/import.js";
import type { ResearchJob, DraftJob, SendJob } from "../../jobs/types.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * When each lead's next approved/queued email is expected to go out. A deferred email carries
 * `scheduledFor`; an approved one without it goes as soon as the send window allows.
 */
export async function nextSendAtMap(ctx: AppContext, leadIds: string[], rules: HardRules, now: Date = new Date()): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!leadIds.length) return map;
  const rows = await ctx.db
    .select({ leadId: emails.leadId, scheduledFor: emails.scheduledFor, status: emails.status })
    .from(emails)
    .where(and(inArray(emails.leadId, leadIds), eq(emails.direction, "outbound"), inArray(emails.status, ["approved", "queued", "sending"])))
    .orderBy(desc(emails.createdAt));
  const asap = nextSendWindow(now, rules).next.toISOString();
  for (const r of rows) {
    if (map.has(r.leadId)) continue;
    map.set(r.leadId, r.scheduledFor ? r.scheduledFor.toISOString() : asap);
  }
  return map;
}

export function toLeadDto(l: LeadRow, nextSendAt: string | null = null): LeadDto {
  return {
    id: l.id,
    campaignId: l.campaignId,
    rowNumber: l.rowNumber,
    email: l.email,
    firstName: l.firstName,
    lastName: l.lastName,
    company: l.company,
    website: l.website,
    jobTitle: l.jobTitle,
    linkedinUrl: l.linkedinUrl,
    industry: l.industry,
    location: l.location,
    phone: l.phone,
    notes: l.notes,
    extra: l.extra ?? {},
    status: l.status,
    currentStep: l.currentStep,
    nextActionAt: iso(l.nextActionAt),
    nextSendAt,
    persona: l.persona ?? null,
    matchedServices: l.matchedServices ?? null,
    lastError: l.lastError,
    sentAt: iso(l.sentAt),
    deliveredAt: iso(l.deliveredAt),
    openedAt: iso(l.openedAt),
    clickedAt: iso(l.clickedAt),
    repliedAt: iso(l.repliedAt),
    bouncedAt: iso(l.bouncedAt),
    complainedAt: iso(l.complainedAt),
    unsubscribedAt: iso(l.unsubscribedAt),
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

export interface CampaignDtoExtras {
  createdByName: string | null;
  myAccess: CampaignAccessLevel;
}

/** Display names of campaign owners, keyed by user id. */
export async function ownerNames(ctx: AppContext, rows: Array<Pick<CampaignRow, "createdBy">>): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const found = await ctx.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.name]));
}

export function toCampaignDto(c: CampaignRow, counts: CampaignCounts, extras: CampaignDtoExtras): CampaignDto {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
    approvalMode: c.approvalMode,
    sequence: c.sequence,
    serviceIds: c.serviceIds ?? [],
    fromEmail: c.fromEmail,
    fromName: c.fromName,
    replyTo: c.replyTo,
    extraGuidance: c.extraGuidance,
    hardRulesOverride: c.hardRulesOverride ?? null,
    sourceFileName: c.sourceFileName,
    headerMap: c.headerMap ?? null,
    importSummary: c.importSummary ?? null,
    counts,
    createdBy: c.createdBy,
    createdByName: extras.createdByName,
    myAccess: extras.myAccess,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    startedAt: iso(c.startedAt),
    completedAt: iso(c.completedAt),
  };
}

const EMPTY_COUNTS: CampaignCounts = {
  total: 0, pending: 0, researching: 0, drafting: 0, pendingReview: 0, approved: 0, sent: 0, delivered: 0,
  opened: 0, clicked: 0, replied: 0, bounced: 0, complained: 0, unsubscribed: 0, failed: 0, other: 0,
};

export async function campaignCountsMap(ctx: AppContext, campaignIds: string[]): Promise<Map<string, CampaignCounts>> {
  const map = new Map<string, CampaignCounts>();
  if (!campaignIds.length) return map;
  const rows = await ctx.db
    .select({ campaignId: leads.campaignId, status: leads.status, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(inArray(leads.campaignId, campaignIds))
    .groupBy(leads.campaignId, leads.status);
  for (const r of rows) {
    const c = map.get(r.campaignId) ?? { ...EMPTY_COUNTS };
    c.total += r.count;
    switch (r.status as LeadStatus) {
      case "pending": c.pending += r.count; break;
      case "researching": case "researched": c.researching += r.count; break;
      case "drafting": c.drafting += r.count; break;
      case "pending_review": c.pendingReview += r.count; break;
      case "approved": case "scheduled": case "sending": c.approved += r.count; break;
      case "sent": c.sent += r.count; break;
      case "delivered": c.delivered += r.count; break;
      case "opened": c.opened += r.count; break;
      case "clicked": c.clicked += r.count; break;
      case "replied": c.replied += r.count; break;
      case "bounced": c.bounced += r.count; break;
      case "complained": c.complained += r.count; break;
      case "unsubscribed": c.unsubscribed += r.count; break;
      case "failed": c.failed += r.count; break;
      default: c.other += r.count;
    }
    map.set(r.campaignId, c);
  }
  // "sent" in the funnel sense = everything at or past sent.
  for (const c of map.values()) {
    c.sent = c.sent + c.delivered + c.opened + c.clicked + c.replied;
    c.delivered = c.delivered + c.opened + c.clicked;
    c.opened = c.opened + c.clicked;
  }
  return map;
}

export async function campaignCounts(ctx: AppContext, campaignId: string): Promise<CampaignCounts> {
  return (await campaignCountsMap(ctx, [campaignId])).get(campaignId) ?? { ...EMPTY_COUNTS };
}

export async function getCampaignOrThrow(ctx: AppContext, id: string): Promise<CampaignRow> {
  const [c] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!c) throw AppError.notFound("Campaign");
  return c;
}

export async function getLeadOrThrow(ctx: AppContext, id: string): Promise<LeadRow> {
  const [l] = await ctx.db.select().from(leads).where(eq(leads.id, id)).limit(1);
  if (!l) throw AppError.notFound("Lead");
  return l;
}

export interface CreateCampaignArgs {
  input: CreateCampaignInput;
  sheet: ParsedSheet;
  file: { buffer: Buffer; filename: string; mimeType: string };
  userId: string | null;
}

/** Persist the upload, create the campaign and its leads (skipping suppressed addresses). */
export async function createCampaignFromSheet(ctx: AppContext, args: CreateCampaignArgs): Promise<CampaignRow> {
  const imp = buildLeadImport(args.sheet);
  if (imp.missingRequired.length) {
    throw AppError.badRequest(`Missing required column(s): ${imp.missingRequired.join(", ")}`, {
      headers: args.sheet.headers,
      unmapped: imp.unmapped,
    });
  }
  if (imp.valid.length === 0) throw AppError.badRequest("No valid rows with an email address were found", { invalid: imp.invalid.slice(0, 20) });

  const emailsInSheet = imp.valid.map((r) => r.email);
  const suppressedRows = await ctx.db
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(inArray(suppressions.email, emailsInSheet));
  const suppressedSet = new Set(suppressedRows.map((r) => r.email));

  const key = `uploads/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${args.file.filename}`;
  await ctx.storage.put(key, args.file.buffer, args.file.mimeType);
  const [fileRow] = await ctx.db
    .insert(files)
    .values({
      kind: "leads_upload",
      storage: ctx.storage.driver,
      key,
      originalName: args.file.filename,
      mimeType: args.file.mimeType,
      sizeBytes: args.file.buffer.length,
      createdBy: args.userId,
    })
    .returning();

  const summary: ImportSummary = {
    totalRows: imp.totalRows,
    imported: 0,
    duplicatesInSheet: imp.duplicates,
    invalidEmails: imp.invalid.length,
    suppressed: 0,
    missingRequired: imp.missingRequired,
    unmappedColumns: imp.unmapped,
    sampleErrors: imp.invalid.slice(0, 20),
  };

  return ctx.db.transaction(async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values({
        name: args.input.name,
        description: args.input.description ?? "",
        approvalMode: args.input.approvalMode,
        sequence: args.input.sequence,
        serviceIds: args.input.serviceIds,
        fromEmail: args.input.fromEmail ?? null,
        fromName: args.input.fromName ?? null,
        replyTo: args.input.replyTo ?? null,
        extraGuidance: args.input.extraGuidance ?? "",
        hardRulesOverride: args.input.hardRulesOverride ?? null,
        sourceFileId: fileRow.id,
        sourceFileName: args.file.filename,
        headerMap: imp.headerMap,
        originalHeaders: args.sheet.headers,
        createdBy: args.userId,
      })
      .returning();

    const values = imp.valid.map((r) => {
      const isSuppressed = suppressedSet.has(r.email);
      if (isSuppressed) summary.suppressed++;
      else summary.imported++;
      return {
        campaignId: campaign.id,
        rowNumber: r.rowNumber,
        email: r.email,
        firstName: r.fields.first_name || null,
        lastName: r.fields.last_name || null,
        company: r.fields.company || null,
        website: r.fields.website || null,
        jobTitle: r.fields.job_title || null,
        linkedinUrl: r.fields.linkedin_url || null,
        industry: r.fields.industry || null,
        location: r.fields.location || null,
        phone: r.fields.phone || null,
        notes: r.fields.notes || null,
        extra: r.extra,
        status: (isSuppressed ? "suppressed" : "pending") as LeadStatus,
        unsubscribeToken: "", // filled below once we know the id
      };
    });
    // Insert in chunks; then set unsubscribe tokens (HMAC of the generated id).
    const inserted: LeadRow[] = [];
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500).map((v, j) => ({ ...v, unsubscribeToken: `tmp-${campaign.id}-${i + j}` }));
      const rows = await tx.insert(leads).values(chunk).returning();
      inserted.push(...rows);
    }
    for (const row of inserted) {
      await tx
        .update(leads)
        .set({ unsubscribeToken: makeUnsubscribeToken(ctx.config.APP_SECRET, row.id) })
        .where(eq(leads.id, row.id));
    }
    const [updated] = await tx.update(campaigns).set({ importSummary: summary }).where(eq(campaigns.id, campaign.id)).returning();
    return updated;
  });
}

/**
 * Enqueue whatever work each non-terminal lead needs next. Used by start and resume, and safe
 * to call repeatedly (jobs are singleton-keyed per lead + stage).
 */
export async function enqueuePendingWork(ctx: AppContext, campaignId: string): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(leads)
    .where(and(eq(leads.campaignId, campaignId), inArray(leads.status, ["pending", "researching", "researched", "drafting", "approved", "scheduled"])))
    .orderBy(asc(leads.rowNumber));
  let n = 0;
  for (const lead of rows) {
    if (lead.status === "pending" || lead.status === "researching") {
      await ctx.queue.publish<ResearchJob>(JOB_QUEUES.research, { leadId: lead.id }, { singletonKey: `research:${lead.id}` });
      n++;
    } else if (lead.status === "researched" || lead.status === "drafting") {
      const step = Math.max(1, lead.currentStep + 1);
      await ctx.queue.publish<DraftJob>(JOB_QUEUES.draft, { leadId: lead.id, step }, { singletonKey: `draft:${lead.id}:${step}` });
      n++;
    } else if (lead.status === "approved" || lead.status === "scheduled") {
      const [email] = await ctx.db
        .select()
        .from(emails)
        .where(and(eq(emails.leadId, lead.id), inArray(emails.status, ["approved", "queued"])))
        .orderBy(desc(emails.createdAt))
        .limit(1);
      if (email) {
        await ctx.queue.publish<SendJob>(JOB_QUEUES.send, { emailId: email.id }, { singletonKey: `send:${email.id}` });
        n++;
      }
    }
  }
  return n;
}

export async function startCampaign(ctx: AppContext, id: string): Promise<{ campaign: CampaignRow; enqueued: number }> {
  const c = await getCampaignOrThrow(ctx, id);
  if (c.status !== "draft" && c.status !== "paused") throw AppError.conflict(`Campaign is ${c.status}`);
  const [campaign] = await ctx.db
    .update(campaigns)
    .set({ status: "active", startedAt: c.startedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(campaigns.id, id))
    .returning();
  const enqueued = await enqueuePendingWork(ctx, id);
  return { campaign, enqueued };
}

export async function setCampaignStatus(ctx: AppContext, id: string, status: CampaignRow["status"]): Promise<CampaignRow> {
  const c = await getCampaignOrThrow(ctx, id);
  const allowed: Record<string, CampaignRow["status"][]> = {
    paused: ["active"],
    active: ["paused"],
    archived: ["draft", "paused", "completed", "active"],
    completed: ["active", "paused"],
  };
  if (!allowed[status]?.includes(c.status)) throw AppError.conflict(`Cannot move campaign from ${c.status} to ${status}`);
  const [row] = await ctx.db
    .update(campaigns)
    .set({ status, updatedAt: new Date(), completedAt: status === "completed" ? new Date() : c.completedAt })
    .where(eq(campaigns.id, id))
    .returning();
  return row;
}

/** Mark a campaign completed when no lead can progress any further. */
export async function maybeCompleteCampaign(ctx: AppContext, campaignId: string): Promise<boolean> {
  const [c] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!c || c.status !== "active") return false;
  const rows = await ctx.db
    .select({ status: leads.status, currentStep: leads.currentStep })
    .from(leads)
    .where(eq(leads.campaignId, campaignId));
  if (!rows.length) return false;
  const lastStep = c.sequence.length;
  // A lead still needs work unless it is terminal, permanently failed, or has been sent the
  // final step of the sequence (follow-ups in flight keep the campaign active).
  const active = rows.some(
    (r) =>
      !TERMINAL_LEAD_STATUSES.has(r.status) &&
      r.status !== "failed" &&
      !(FOLLOWUP_ELIGIBLE_LEAD_STATUSES.has(r.status) && r.currentStep >= lastStep),
  );
  if (active) return false;
  await ctx.db.update(campaigns).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
  return true;
}

export async function previewSheet(sheet: ParsedSheet) {
  const imp = buildLeadImport(sheet);
  return {
    headers: sheet.headers,
    mapped: imp.headerMap,
    unmapped: imp.unmapped,
    missingRequired: imp.missingRequired,
    sampleRows: sheet.rows.slice(0, 5),
    totalRows: sheet.rows.length,
    validRows: imp.valid.length,
    invalidRows: imp.invalid.length,
    duplicates: imp.duplicates,
    sampleErrors: imp.invalid.slice(0, 10),
  };
}

export { parseSheet };
