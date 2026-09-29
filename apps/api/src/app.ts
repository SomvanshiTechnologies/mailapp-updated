import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import type { AppContext } from "./context.js";
import { AppError } from "./lib/errors.js";
import { authPlugin } from "./modules/auth/plugin.js";
import { authRoutes } from "./modules/auth/routes.js";
import { settingsRoutes } from "./modules/settings/routes.js";
import { servicesRoutes } from "./modules/services/routes.js";
import { instructionsRoutes } from "./modules/instructions/routes.js";
import { campaignsRoutes } from "./modules/campaigns/routes.js";
import { leadsRoutes } from "./modules/campaigns/lead-routes.js";
import { emailsRoutes } from "./modules/emails/routes.js";
import { suppressionsRoutes } from "./modules/suppressions/routes.js";
import { analyticsRoutes } from "./modules/analytics/routes.js";
import { llmRoutes } from "./modules/llm/routes.js";
import { systemRoutes } from "./modules/system/routes.js";
import { webhookRoutes } from "./modules/ses/webhook-routes.js";
import { unsubscribeRoutes } from "./modules/unsubscribe/routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.logger.child({ component: "http" }) as unknown as FastifyBaseLogger,
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: ctx.config.isTest,
  });

  await app.register(sensible);
  await app.register(helmet, {
    contentSecurityPolicy: ctx.config.isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
          },
        }
      : false,
  });
  await app.register(cors, {
    origin: ctx.config.isProd ? [ctx.config.WEB_ORIGIN, ctx.config.PUBLIC_BASE_URL] : true,
    credentials: true,
    allowedHeaders: ["Content-Type", "X-Requested-With", "Authorization"],
  });
  await app.register(cookie, { secret: ctx.config.APP_SECRET });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    allowList: (req) => req.url.startsWith("/webhooks/") || req.url === "/healthz" || req.url === "/readyz",
  });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 20 },
  });
  await app.register(authPlugin, { ctx });

  // SNS posts JSON with content-type text/plain; accept it as JSON.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)), undefined);
    }
  });

  // One-click unsubscribe POSTs arrive as form-urlencoded (RFC 8058).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, err.message);
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: "validation_error", message: "Validation failed", details: err.issues, requestId: req.id },
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests", requestId: req.id } });
    }
    if (status === 413) {
      return reply.status(413).send({ error: { code: "payload_too_large", message: "File or body too large", requestId: req.id } });
    }
    if (status >= 500 || !status) {
      req.log.error({ err }, "unhandled error");
      return reply.status(500).send({ error: { code: "internal_error", message: "Internal server error", requestId: req.id } });
    }
    return reply
      .status(status)
      .send({ error: { code: (err as { code?: string }).code ?? "error", message: (err as Error).message, requestId: req.id } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.status(404).send({ error: { code: "not_found", message: "Route not found", requestId: req.id } });
    }
    return reply.status(404).send("Not found");
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    let db = "ok";
    try {
      await ctx.dbHandle.pool.query("select 1");
    } catch {
      db = "error";
    }
    const queue = (await ctx.queue.healthy()) ? "ok" : "error";
    const ok = db === "ok" && queue === "ok";
    return reply.status(ok ? 200 : 503).send({ ok, db, queue });
  });

  await authRoutes(app, ctx);
  await settingsRoutes(app, ctx);
  await servicesRoutes(app, ctx);
  await instructionsRoutes(app, ctx);
  await campaignsRoutes(app, ctx);
  await leadsRoutes(app, ctx);
  await emailsRoutes(app, ctx);
  await suppressionsRoutes(app, ctx);
  await analyticsRoutes(app, ctx);
  await llmRoutes(app, ctx);
  await systemRoutes(app, ctx);
  await webhookRoutes(app, ctx);
  await unsubscribeRoutes(app, ctx);

  // Serve the dashboard build when present (production single-container mode).
  const webDist = path.resolve(here, "../../web/dist");
  if (existsSync(path.join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false, index: ["index.html"] });
    app.get("/*", async (req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/webhooks/")) {
        return reply.status(404).send({ error: { code: "not_found", message: "Route not found" } });
      }
      return reply.sendFile("index.html");
    });
    ctx.logger.info({ webDist }, "serving dashboard from web/dist");
  }

  return app;
}
