import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { ServiceSchema, type ServiceDto } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { services, type ServiceRow } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { parse, requireUuid } from "../../lib/validate.js";
import { buildServiceImport, parseSheet, splitList } from "../excel/import.js";
import { readUploadedFile } from "../../lib/upload.js";

export function toServiceDto(s: ServiceRow): ServiceDto {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    targetAudience: s.targetAudience,
    valueProps: s.valueProps,
    proofPoints: s.proofPoints,
    url: s.url,
    tags: s.tags,
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function listActiveServices(ctx: AppContext, ids: string[] = []): Promise<ServiceRow[]> {
  const where = ids.length ? and(eq(services.isActive, true), inArray(services.id, ids)) : eq(services.isActive, true);
  return ctx.db.select().from(services).where(where).orderBy(asc(services.name));
}

export async function servicesRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/services", { preHandler: app.authenticate }, async (req) => {
    const includeInactive = (req.query as { includeInactive?: string }).includeInactive === "true";
    const rows = await ctx.db
      .select()
      .from(services)
      .where(includeInactive ? undefined : eq(services.isActive, true))
      .orderBy(asc(services.name));
    return { items: rows.map(toServiceDto) };
  });

  app.post("/api/services", { preHandler: app.requireRole("operator") }, async (req) => {
    const body = parse(ServiceSchema, req.body);
    const [row] = await ctx.db.insert(services).values(body).returning();
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "service.create", entityType: "service", entityId: row.id, metadata: { name: row.name }, ip: req.ip });
    return { service: toServiceDto(row) };
  });

  app.patch("/api/services/:id", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const body = parse(ServiceSchema.partial(), req.body);
    const [row] = await ctx.db.update(services).set({ ...body, updatedAt: new Date() }).where(eq(services.id, id)).returning();
    if (!row) throw AppError.notFound("Service");
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "service.update", entityType: "service", entityId: id, metadata: { fields: Object.keys(body) }, ip: req.ip });
    return { service: toServiceDto(row) };
  });

  app.delete("/api/services/:id", { preHandler: app.requireRole("operator") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const [row] = await ctx.db.update(services).set({ isActive: false, updatedAt: new Date() }).where(eq(services.id, id)).returning();
    if (!row) throw AppError.notFound("Service");
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "service.deactivate", entityType: "service", entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.post("/api/services/import", { preHandler: app.requireRole("operator") }, async (req) => {
    const file = await readUploadedFile(req, [".xlsx", ".csv"]);
    const sheet = await parseSheet(file.buffer, file.filename);
    const { rows, errors, missingRequired } = buildServiceImport(sheet);
    if (missingRequired.length) {
      throw AppError.badRequest(`Missing required columns: ${missingRequired.join(", ")}`, { headers: sheet.headers });
    }
    let imported = 0;
    let updated = 0;
    for (const r of rows) {
      const f = r.fields;
      const values = {
        name: f.name!.trim(),
        description: f.description!.trim(),
        targetAudience: f.target_audience?.trim() ?? "",
        valueProps: splitList(f.value_props),
        proofPoints: splitList(f.proof_points),
        url: f.url?.trim() ?? "",
        tags: splitList(f.tags).map((t) => t.toLowerCase()),
        isActive: true,
        updatedAt: new Date(),
      };
      const [existing] = await ctx.db.select().from(services).where(eq(services.name, values.name)).limit(1);
      if (existing) {
        await ctx.db.update(services).set(values).where(eq(services.id, existing.id));
        updated++;
      } else {
        await ctx.db.insert(services).values(values);
        imported++;
      }
    }
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "service.import", entityType: "service", metadata: { imported, updated, errors: errors.length, file: file.filename }, ip: req.ip });
    return { imported, updated, errors };
  });
}
