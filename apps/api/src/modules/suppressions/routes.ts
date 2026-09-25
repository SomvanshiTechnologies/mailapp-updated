import type { FastifyInstance } from "fastify";
import { desc, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import { SuppressionSchema } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { suppressions } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { parse, requireUuid } from "../../lib/validate.js";
import { readUploadedFile } from "../../lib/upload.js";
import { isValidEmail, normalizeEmail, parseSheet } from "../excel/import.js";
import { buildSuppressionsWorkbook } from "../excel/export.js";
import { XLSX_MIME } from "../settings/routes.js";
import { addSuppression, toSuppressionDto } from "./service.js";

export async function suppressionsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/suppressions", { preHandler: app.authenticate }, async (req) => {
    const q = parse(
      z.object({
        search: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const where = q.search ? ilike(suppressions.email, `%${q.search.replace(/[%_]/g, "")}%`) : undefined;
    const [{ count }] = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(suppressions).where(where);
    const rows = await ctx.db
      .select()
      .from(suppressions)
      .where(where)
      .orderBy(desc(suppressions.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return { items: rows.map(toSuppressionDto), page: q.page, pageSize: q.pageSize, total: count };
  });

  /** Whole list as xlsx; the file re-imports through POST /api/suppressions/import. */
  app.get("/api/suppressions/export", { preHandler: app.authenticate }, async (req, reply) => {
    const rows = await ctx.db.select().from(suppressions).orderBy(desc(suppressions.createdAt));
    const buffer = await buildSuppressionsWorkbook(rows);
    const name = `suppressions-${new Date().toISOString().slice(0, 10)}.xlsx`;
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "suppression.export", entityType: "suppression", metadata: { rows: rows.length }, ip: req.ip });
    return reply.header("content-type", XLSX_MIME).header("content-disposition", `attachment; filename="${name}"`).send(buffer);
  });

  app.post("/api/suppressions", { preHandler: app.requireRole("operator") }, async (req) => {
    const body = parse(SuppressionSchema, req.body);
    const row = await addSuppression(ctx, { ...body, source: "dashboard", createdBy: req.user!.sub });
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "suppression.add", entityType: "suppression", entityId: row.id, metadata: { email: row.email, reason: row.reason }, ip: req.ip });
    return { suppression: toSuppressionDto(row) };
  });

  app.delete("/api/suppressions/:id", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const deleted = await ctx.db.delete(suppressions).where(eq(suppressions.id, id)).returning();
    if (!deleted.length) throw AppError.notFound("Suppression");
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "suppression.remove", entityType: "suppression", entityId: id, metadata: { email: deleted[0].email }, ip: req.ip });
    return { ok: true };
  });

  app.post("/api/suppressions/import", { preHandler: app.requireRole("operator") }, async (req) => {
    const file = await readUploadedFile(req, [".xlsx", ".csv"]);
    const sheet = await parseSheet(file.buffer, file.filename);
    const emailHeader = sheet.headers.find((h) => /e-?mail/i.test(h)) ?? sheet.headers[0];
    let imported = 0;
    for (const row of sheet.rows) {
      const email = normalizeEmail(row[emailHeader] ?? "");
      if (!isValidEmail(email)) continue;
      const before = await ctx.db.select({ id: suppressions.id }).from(suppressions).where(eq(suppressions.email, email)).limit(1);
      if (before.length) continue;
      await addSuppression(ctx, { email, reason: "manual", source: `import:${file.filename}`, createdBy: req.user!.sub });
      imported++;
    }
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "suppression.import", entityType: "suppression", metadata: { imported, file: file.filename }, ip: req.ip });
    return { imported };
  });
}
