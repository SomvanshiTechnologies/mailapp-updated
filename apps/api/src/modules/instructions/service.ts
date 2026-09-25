import { and, desc, eq, isNull } from "drizzle-orm";
import type { InstructionDto, InstructionKind } from "@mailapp/shared";
import { INSTRUCTION_KINDS } from "@mailapp/shared";
import type { Db } from "../../db/client.js";
import { instructionDocs, type InstructionRow } from "../../db/schema.js";
import type { InstructionBundle } from "../llm/provider.js";

export function toInstructionDto(r: InstructionRow): InstructionDto {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    content: r.content,
    version: r.version,
    isActive: r.isActive,
    createdBy: r.createdBy,
    ownerId: r.ownerId,
    createdAt: r.createdAt.toISOString(),
  };
}

function concatKind(rows: InstructionRow[], kind: InstructionKind): string {
  const ofKind = rows.filter((r) => r.kind === kind);
  return ofKind
    .slice()
    .reverse()
    .map((r) => (ofKind.length > 1 ? `### ${r.title}\n${r.content}` : r.content))
    .join("\n\n");
}

/**
 * Collect the active instruction documents into the bundle used by the prompts.
 *
 * Organisation docs (ownerId null, admin managed) are the baseline. When `ownerId` is given
 * and that user has active personal docs of a kind, those replace the organisation docs of
 * that kind; kinds the user has not customised fall back to the organisation's.
 * Several active docs of the same kind are concatenated (newest last) so teams can layer rules.
 */
export async function loadInstructionBundle(db: Db, ownerId: string | null = null): Promise<InstructionBundle> {
  const orgRows = await db
    .select()
    .from(instructionDocs)
    .where(and(eq(instructionDocs.isActive, true), isNull(instructionDocs.ownerId)))
    .orderBy(desc(instructionDocs.createdAt));
  const mineRows = ownerId
    ? await db
        .select()
        .from(instructionDocs)
        .where(and(eq(instructionDocs.isActive, true), eq(instructionDocs.ownerId, ownerId)))
        .orderBy(desc(instructionDocs.createdAt))
    : [];
  const byKind = (kind: InstructionKind) => (mineRows.some((r) => r.kind === kind) ? concatKind(mineRows, kind) : concatKind(orgRows, kind));
  return {
    companyProfile: byKind("company_profile"),
    tone: byKind("tone"),
    format: byKind("format"),
    rules: byKind("rules"),
    signature: byKind("signature"),
    followupGuidance: byKind("followup_guidance"),
    other: byKind("other"),
  };
}

/** Which kinds a user has personalised (for the UI "overrides organisation" hint). */
export async function personalisedKinds(db: Db, ownerId: string): Promise<InstructionKind[]> {
  const rows = await db
    .select({ kind: instructionDocs.kind })
    .from(instructionDocs)
    .where(and(eq(instructionDocs.isActive, true), eq(instructionDocs.ownerId, ownerId)));
  const set = new Set(rows.map((r) => r.kind));
  return INSTRUCTION_KINDS.filter((k) => set.has(k));
}

/** Create a new version of a doc (same scope + kind + title) and deactivate older versions of it. */
export async function createInstruction(
  db: Db,
  input: { kind: InstructionKind; title: string; content: string; isActive: boolean; createdBy: string | null; ownerId: string | null },
): Promise<InstructionRow> {
  const scope = input.ownerId ? eq(instructionDocs.ownerId, input.ownerId) : isNull(instructionDocs.ownerId);
  const sameDoc = and(eq(instructionDocs.kind, input.kind), eq(instructionDocs.title, input.title), scope);
  const [latest] = await db.select().from(instructionDocs).where(sameDoc).orderBy(desc(instructionDocs.version)).limit(1);
  const version = latest ? latest.version + 1 : 1;
  if (latest && input.isActive) {
    await db.update(instructionDocs).set({ isActive: false }).where(sameDoc);
  }
  const [row] = await db
    .insert(instructionDocs)
    .values({
      kind: input.kind,
      title: input.title,
      content: input.content,
      version,
      isActive: input.isActive,
      createdBy: input.createdBy,
      ownerId: input.ownerId,
    })
    .returning();
  return row;
}
