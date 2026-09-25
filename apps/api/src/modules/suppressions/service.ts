import { and, eq } from "drizzle-orm";
import type { SuppressionDto, SuppressionReason } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { emails, leads, suppressions, type LeadRow, type SuppressionRow } from "../../db/schema.js";

export function toSuppressionDto(s: SuppressionRow): SuppressionDto {
  return { id: s.id, email: s.email, reason: s.reason, note: s.note, source: s.source, createdAt: s.createdAt.toISOString() };
}

export async function isSuppressed(ctx: AppContext, email: string): Promise<boolean> {
  const [row] = await ctx.db.select({ id: suppressions.id }).from(suppressions).where(eq(suppressions.email, email.toLowerCase())).limit(1);
  return !!row;
}

export async function addSuppression(
  ctx: AppContext,
  input: { email: string; reason: SuppressionReason; note?: string; source?: string; createdBy?: string | null },
): Promise<SuppressionRow> {
  const email = input.email.toLowerCase();
  const [row] = await ctx.db
    .insert(suppressions)
    .values({ email, reason: input.reason, note: input.note, source: input.source, createdBy: input.createdBy ?? null })
    .onConflictDoNothing({ target: suppressions.email })
    .returning();
  if (row) return row;
  const [existing] = await ctx.db.select().from(suppressions).where(eq(suppressions.email, email)).limit(1);
  return existing;
}

/**
 * Mark a lead unsubscribed everywhere: lead status, pending emails cancelled, suppression row.
 * Idempotent.
 */
export async function unsubscribeLead(ctx: AppContext, lead: LeadRow, source: string, userId: string | null = null): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(leads)
      .set({ status: "unsubscribed", unsubscribedAt: lead.unsubscribedAt ?? new Date(), nextActionAt: null, updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
    await tx
      .update(emails)
      .set({ status: "rejected", reviewNote: "unsubscribed", updatedAt: new Date() })
      .where(eq(emails.leadId, lead.id));
  });
  // Cancel drafts that were approved/queued but not yet sent (the send job re-checks status too).
  await addSuppression(ctx, { email: lead.email, reason: "unsubscribe", source, createdBy: userId });
  // Other campaigns with the same address are stopped too.
  const others = await ctx.db.select().from(leads).where(eq(leads.email, lead.email));
  for (const o of others) {
    if (o.id !== lead.id && !["replied", "bounced", "complained", "unsubscribed"].includes(o.status)) {
      await ctx.db
        .update(leads)
        .set({ status: "unsubscribed", unsubscribedAt: new Date(), nextActionAt: null, updatedAt: new Date() })
        .where(eq(leads.id, o.id));
    }
  }
  ctx.metrics.emit("unsubscribes", 1, { source });
}

/**
 * Undo an unsubscribe ("Subscribe again" on the preferences page). Removes the unsubscribe
 * suppression (bounce/complaint suppressions are kept) and closes the lead's sequence: a lead
 * who had been emailed becomes "completed", one who never was becomes "skipped". Follow-ups
 * that were cancelled are not revived; future campaigns may email the address again.
 */
export async function resubscribeLead(ctx: AppContext, lead: LeadRow, source: string): Promise<void> {
  const email = lead.email.toLowerCase();
  await ctx.db.delete(suppressions).where(and(eq(suppressions.email, email), eq(suppressions.reason, "unsubscribe")));
  const same = await ctx.db.select().from(leads).where(eq(leads.email, email));
  for (const l of same) {
    if (l.status !== "unsubscribed") continue;
    await ctx.db
      .update(leads)
      .set({ status: l.sentAt ? "completed" : "skipped", unsubscribedAt: null, nextActionAt: null, updatedAt: new Date() })
      .where(eq(leads.id, l.id));
  }
  ctx.metrics.emit("resubscribes", 1, { source });
}
