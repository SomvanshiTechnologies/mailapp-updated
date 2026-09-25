import type { FastifyInstance } from "fastify";
import { desc, eq, isNull, or } from "drizzle-orm";
import { LandingPageSchema, SettingsSchema } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { instructionDocs, services } from "../../db/schema.js";
import { parse } from "../../lib/validate.js";
import { buildSettingsWorkbook } from "../excel/export.js";
import { listActiveServices } from "../services/routes.js";
import { renderLandingPage } from "../unsubscribe/landing.js";
import { assertSenderVerified } from "./sender.js";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function settingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/settings", { preHandler: app.authenticate }, async () => {
    return { settings: await ctx.settings.get() };
  });

  app.put("/api/settings", { preHandler: app.requireRole("admin") }, async (req) => {
    const body = parse(SettingsSchema, req.body);
    await assertSenderVerified(ctx, body.fromEmail);
    const settings = await ctx.settings.update(body, req.user!.sub);
    await ctx.audit.log({
      userId: req.user!.sub,
      userEmail: req.user!.email,
      action: "settings.update",
      entityType: "settings",
      entityId: "app",
      metadata: { keys: Object.keys(body) },
      ip: req.ip,
    });
    return { settings };
  });

  // ----- Preferences / unsubscribe landing page (Services → Manage link page) -----
  app.put("/api/settings/landing", { preHandler: app.requireRole("admin") }, async (req) => {
    const landingPage = parse(LandingPageSchema, req.body);
    const current = await ctx.settings.get();
    const { updatedAt: _u, ...rest } = current;
    const settings = await ctx.settings.update({ ...rest, landingPage }, req.user!.sub);
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "settings.landing_update", entityType: "settings", entityId: "landing", metadata: { showUnsubscribe: landingPage.showUnsubscribe, services: landingPage.services.length }, ip: req.ip });
    return { landingPage: settings.landingPage };
  });

  /** Render a draft of the landing page exactly as recipients will see it (for the editor's preview). */
  app.post("/api/settings/landing/preview", { preHandler: app.authenticate }, async (req, reply) => {
    const config = parse(LandingPageSchema, req.body ?? {});
    const settings = await ctx.settings.get();
    const html = renderLandingPage({
      config,
      services: await listActiveServices(ctx),
      state: { kind: "preview", email: "recipient@example.com" },
      unsubscribeUrl: "#",
      orgName: settings.fromName,
    });
    return reply.type("text/html").send(html);
  });

  /** Settings + hard rules + instruction docs (organisation and the caller's own) + services as one workbook. */
  app.get("/api/settings/export", { preHandler: app.authenticate }, async (req, reply) => {
    const settings = await ctx.settings.get();
    const docs = await ctx.db
      .select()
      .from(instructionDocs)
      .where(or(isNull(instructionDocs.ownerId), eq(instructionDocs.ownerId, req.user!.sub)))
      .orderBy(desc(instructionDocs.createdAt));
    const svc = await ctx.db.select().from(services).orderBy(services.name);
    const buffer = await buildSettingsWorkbook({ settings, instructions: docs, services: svc, exportedBy: req.user!.email });
    const name = `outreach-settings-${new Date().toISOString().slice(0, 10)}.xlsx`;
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "settings.export", entityType: "settings", entityId: "app", metadata: { instructions: docs.length, services: svc.length }, ip: req.ip });
    return reply.header("content-type", XLSX_MIME).header("content-disposition", `attachment; filename="${name}"`).send(buffer);
  });
}
