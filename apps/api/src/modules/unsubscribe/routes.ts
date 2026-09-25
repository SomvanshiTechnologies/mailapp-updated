import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { AppContext } from "../../context.js";
import { leads } from "../../db/schema.js";
import { verifyUnsubscribeToken } from "../../lib/crypto.js";
import { listActiveServices } from "../services/routes.js";
import { resubscribeLead, unsubscribeLead } from "../suppressions/service.js";
import { renderLandingPage, type LandingState } from "./landing.js";

/**
 * Public preferences page reached from the link at the bottom of every email: shows the
 * services (configured under Services → Manage link page) and, when enabled, a small
 * unsubscribe button. The POST stays RFC 8058 one-click compatible.
 */
export async function unsubscribeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const resolve = async (token: string) => {
    const leadId = verifyUnsubscribeToken(ctx.config.APP_SECRET, token);
    if (!leadId) return null;
    const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    return lead ?? null;
  };

  const render = async (token: string, state: LandingState) => {
    const settings = await ctx.settings.get();
    return renderLandingPage({
      config: settings.landingPage,
      services: await listActiveServices(ctx),
      state,
      unsubscribeUrl: `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, "")}/u/${token}`,
      orgName: settings.fromName,
    });
  };

  app.get("/u/:token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const lead = await resolve(token);
    reply.type("text/html");
    if (!lead) return reply.status(404).send(await render(token, { kind: "invalid" }));
    if (lead.status === "unsubscribed") return reply.send(await render(token, { kind: "unsubscribed", email: lead.email }));
    return reply.send(await render(token, { kind: "active", email: lead.email }));
  });

  // RFC 8058 one-click (mail clients POST with List-Unsubscribe=One-Click) and the page's button.
  app.post("/u/:token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const lead = await resolve(token);
    if (!lead) return reply.status(404).send({ ok: false });
    if (lead.status !== "unsubscribed") {
      await unsubscribeLead(ctx, lead, "link");
      await ctx.audit.log({ action: "lead.unsubscribe_link", entityType: "lead", entityId: lead.id, metadata: { email: lead.email }, ip: req.ip });
    }
    const accept = String(req.headers.accept ?? "");
    if (accept.includes("text/html")) {
      return reply.type("text/html").send(await render(token, { kind: "unsubscribed", email: lead.email }));
    }
    return reply.send({ ok: true });
  });

  /** "Subscribe again" from the page: lifts the unsubscribe suppression so future campaigns may email them. */
  app.post("/u/:token/resubscribe", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const lead = await resolve(token);
    if (!lead) return reply.status(404).send({ ok: false });
    if (lead.status === "unsubscribed") {
      await resubscribeLead(ctx, lead, "link");
      await ctx.audit.log({ action: "lead.resubscribe_link", entityType: "lead", entityId: lead.id, metadata: { email: lead.email }, ip: req.ip });
    }
    const accept = String(req.headers.accept ?? "");
    if (accept.includes("text/html")) {
      return reply.type("text/html").send(await render(token, { kind: "resubscribed", email: lead.email }));
    }
    return reply.send({ ok: true });
  });
}
