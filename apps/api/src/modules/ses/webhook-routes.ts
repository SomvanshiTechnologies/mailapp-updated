import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";
import { confirmSubscription, verifySnsEnvelope } from "./sns.js";
import { processSesEvent, type SesEventPayload } from "./events.js";
import { processInboundNotification, type SesInboundNotification } from "./inbound.js";

function parseMessage(env: { Message: string }): unknown {
  try {
    return JSON.parse(env.Message);
  } catch {
    return null;
  }
}

export async function webhookRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/webhooks/ses/events", { config: { rateLimit: false } }, async (req, reply) => {
    const env = await verifySnsEnvelope(ctx, req.body);
    if (env.Type === "SubscriptionConfirmation") {
      await confirmSubscription(ctx, env);
      return reply.send({ ok: true, confirmed: true });
    }
    if (env.Type === "UnsubscribeConfirmation") {
      ctx.logger.warn({ topic: env.TopicArn }, "SNS UnsubscribeConfirmation received");
      return reply.send({ ok: true });
    }
    const payload = parseMessage(env) as SesEventPayload | null;
    if (!payload) {
      ctx.logger.warn({ snsMessageId: env.MessageId }, "SNS Message is not JSON");
      return reply.send({ ok: true, ignored: true });
    }
    const result = await processSesEvent(ctx, payload);
    req.log.info({ result, snsMessageId: env.MessageId }, "ses event processed");
    return reply.send({ ok: true, ...result });
  });

  app.post("/webhooks/ses/inbound", { config: { rateLimit: false } }, async (req, reply) => {
    const env = await verifySnsEnvelope(ctx, req.body);
    if (env.Type === "SubscriptionConfirmation") {
      await confirmSubscription(ctx, env);
      return reply.send({ ok: true, confirmed: true });
    }
    if (env.Type !== "Notification") return reply.send({ ok: true });
    const payload = parseMessage(env) as SesInboundNotification | null;
    if (!payload) return reply.send({ ok: true, ignored: true });
    const result = await processInboundNotification(ctx, payload);
    req.log.info({ result, snsMessageId: env.MessageId }, "inbound processed");
    return reply.send({ ok: true, ...result });
  });
}
