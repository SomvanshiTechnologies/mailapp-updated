import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { INSTRUCTION_KINDS, INSTRUCTION_SCOPES, InstructionSchema, type InstructionKind, type InstructionScope } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { instructionDocs } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { parse, requireUuid } from "../../lib/validate.js";
import { readUploadedFile } from "../../lib/upload.js";
import { parseSheet } from "../excel/import.js";
import { createInstruction, personalisedKinds, toInstructionDto } from "./service.js";
import { extractTextFromUpload } from "./text-extract.js";

const ScopeSchema = z.enum(INSTRUCTION_SCOPES).default("org");

/**
 * Organisation documents (scope "org") are managed by admins only; every operator/admin may
 * keep personal documents (scope "mine") that override the organisation's for their own
 * campaigns. Returns the owner id to store for the requested scope.
 */
function ownerForScope(req: FastifyRequest, scope: InstructionScope): string | null {
  const user = req.user!;
  if (scope === "org") {
    if (user.role !== "admin") throw AppError.forbidden("Only administrators can change organisation instructions");
    return null;
  }
  if (user.role === "viewer") throw AppError.forbidden("Viewers cannot create instructions");
  return user.sub;
}

async function loadEditable(ctx: AppContext, req: FastifyRequest, id: string) {
  const [row] = await ctx.db.select().from(instructionDocs).where(eq(instructionDocs.id, id)).limit(1);
  if (!row) throw AppError.notFound("Instruction");
  const user = req.user!;
  if (row.ownerId === null && user.role !== "admin") throw AppError.forbidden("Only administrators can change organisation instructions");
  if (row.ownerId !== null && row.ownerId !== user.sub && user.role !== "admin") throw AppError.forbidden("Not your instruction");
  return row;
}

export async function instructionsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/instructions", { preHandler: app.authenticate }, async (req) => {
    const q = parse(
      z.object({
        scope: ScopeSchema,
        kind: z.enum(INSTRUCTION_KINDS).optional(),
        includeInactive: z.enum(["true", "false"]).optional(),
      }),
      req.query,
    );
    const conds = [q.scope === "org" ? isNull(instructionDocs.ownerId) : eq(instructionDocs.ownerId, req.user!.sub)];
    if (q.kind) conds.push(eq(instructionDocs.kind, q.kind));
    if (q.includeInactive !== "true") conds.push(eq(instructionDocs.isActive, true));
    const rows = await ctx.db.select().from(instructionDocs).where(and(...conds)).orderBy(desc(instructionDocs.createdAt));
    return {
      items: rows.map(toInstructionDto),
      scope: q.scope,
      /** Kinds where the caller's personal docs override the organisation's. */
      personalisedKinds: await personalisedKinds(ctx.db, req.user!.sub),
    };
  });

  app.post("/api/instructions", { preHandler: app.requireRole("operator") }, async (req) => {
    const body = parse(InstructionSchema.extend({ scope: ScopeSchema }), req.body);
    const ownerId = ownerForScope(req, body.scope);
    const row = await createInstruction(ctx.db, { ...body, createdBy: req.user!.sub, ownerId });
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "instruction.create", entityType: "instruction", entityId: row.id, metadata: { kind: row.kind, title: row.title, version: row.version, scope: body.scope }, ip: req.ip });
    return { instruction: toInstructionDto(row) };
  });

  app.post("/api/instructions/upload", { preHandler: app.requireRole("operator") }, async (req) => {
    const file = await readUploadedFile(req, [".md", ".txt", ".docx"], 5 * 1024 * 1024);
    const meta = parse(
      z.object({ kind: z.enum(INSTRUCTION_KINDS), title: z.string().min(1).max(160).optional(), scope: ScopeSchema }),
      file.fields,
    );
    const ownerId = ownerForScope(req, meta.scope);
    const content = await extractTextFromUpload(file.buffer, file.filename);
    if (!content.trim()) throw AppError.badRequest("Uploaded document has no readable text");
    const row = await createInstruction(ctx.db, {
      kind: meta.kind,
      title: meta.title ?? file.filename.replace(/\.[^.]+$/, ""),
      content: content.slice(0, 50_000),
      isActive: true,
      createdBy: req.user!.sub,
      ownerId,
    });
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "instruction.upload", entityType: "instruction", entityId: row.id, metadata: { kind: row.kind, title: row.title, file: file.filename, scope: meta.scope }, ip: req.ip });
    return { instruction: toInstructionDto(row) };
  });

  /**
   * Import instruction documents from a workbook (the "Instructions" sheet of a settings
   * export, or any sheet with kind / title / content columns). Lets one user hand their
   * documents to another.
   */
  app.post("/api/instructions/import", { preHandler: app.requireRole("operator") }, async (req) => {
    const file = await readUploadedFile(req, [".xlsx", ".csv"], 10 * 1024 * 1024);
    const meta = parse(z.object({ scope: ScopeSchema }), file.fields);
    const ownerId = ownerForScope(req, meta.scope);
    const sheet = await parseSheet(file.buffer, file.filename, "Instructions");
    const col = (name: string) => sheet.headers.find((h) => h.trim().toLowerCase() === name) ?? "";
    const kindCol = col("kind");
    const titleCol = col("title");
    const contentCol = col("content");
    if (!kindCol || !titleCol || !contentCol) throw AppError.badRequest("Sheet needs kind, title and content columns", { headers: sheet.headers });
    let imported = 0;
    const skipped: Array<{ row: number; reason: string }> = [];
    for (let i = 0; i < sheet.rows.length; i++) {
      const r = sheet.rows[i];
      const kind = String(r[kindCol] ?? "").trim() as InstructionKind;
      const title = String(r[titleCol] ?? "").trim();
      const content = String(r[contentCol] ?? "").trim();
      if (!INSTRUCTION_KINDS.includes(kind)) {
        skipped.push({ row: i + 2, reason: `unknown kind "${kind}"` });
        continue;
      }
      if (!title || !content) {
        skipped.push({ row: i + 2, reason: "missing title or content" });
        continue;
      }
      await createInstruction(ctx.db, { kind, title: title.slice(0, 160), content: content.slice(0, 50_000), isActive: true, createdBy: req.user!.sub, ownerId });
      imported++;
    }
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "instruction.import", entityType: "instruction", metadata: { imported, skipped: skipped.length, file: file.filename, scope: meta.scope }, ip: req.ip });
    return { imported, skipped };
  });

  app.patch("/api/instructions/:id", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const body = parse(z.object({ isActive: z.boolean().optional(), title: z.string().min(1).max(160).optional() }), req.body);
    await loadEditable(ctx, req, id);
    const [row] = await ctx.db.update(instructionDocs).set(body).where(eq(instructionDocs.id, id)).returning();
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "instruction.update", entityType: "instruction", entityId: id, metadata: body, ip: req.ip });
    return { instruction: toInstructionDto(row) };
  });

  app.delete("/api/instructions/:id", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    await loadEditable(ctx, req, id);
    await ctx.db.delete(instructionDocs).where(eq(instructionDocs.id, id));
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "instruction.delete", entityType: "instruction", entityId: id, ip: req.ip });
    return { ok: true };
  });
}
