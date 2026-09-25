import MessageValidator from "sns-validator";
import type { AppContext } from "../../context.js";
import { AppError } from "../../lib/errors.js";

export interface SnsEnvelope {
  Type: "SubscriptionConfirmation" | "Notification" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Subject?: string;
  Timestamp: string;
  SubscribeURL?: string;
  Token?: string;
  Signature?: string;
  SignatureVersion?: string;
  SigningCertURL?: string;
}

const validator = new MessageValidator();

export function validateSnsSignature(body: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    validator.validate(body, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Verify an SNS envelope: signature (unless disabled for tests) and topic allow-list.
 * Returns the envelope. Throws AppError(403) on failure.
 */
export async function verifySnsEnvelope(ctx: AppContext, body: unknown): Promise<SnsEnvelope> {
  if (!body || typeof body !== "object") throw AppError.badRequest("Invalid SNS body");
  const env = body as SnsEnvelope;
  if (!env.Type || !env.TopicArn) throw AppError.badRequest("Not an SNS message");
  const allowed = ctx.config.snsAllowedTopicArns;
  if (allowed.length && !allowed.includes(env.TopicArn)) {
    ctx.metrics.emit("webhook_signature_failures", 1, { reason: "topic" });
    throw AppError.forbidden("Topic not allowed");
  }
  if (ctx.config.SNS_VERIFY_SIGNATURES) {
    try {
      await validateSnsSignature(body as Record<string, unknown>);
    } catch (err) {
      ctx.metrics.emit("webhook_signature_failures", 1, { reason: "signature" });
      ctx.logger.warn({ err, topic: env.TopicArn }, "SNS signature validation failed");
      throw AppError.forbidden("Invalid SNS signature");
    }
  }
  return env;
}

/** Confirm a subscription by fetching SubscribeURL (SNS requirement). */
export async function confirmSubscription(ctx: AppContext, env: SnsEnvelope, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!env.SubscribeURL) throw AppError.badRequest("Missing SubscribeURL");
  const url = new URL(env.SubscribeURL);
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname) || url.protocol !== "https:") {
    throw AppError.forbidden("SubscribeURL host not allowed");
  }
  const res = await fetchImpl(env.SubscribeURL);
  ctx.logger.info({ topic: env.TopicArn, status: res.status }, "SNS subscription confirmed");
  await ctx.audit.log({ action: "sns.subscription_confirmed", entityType: "sns_topic", entityId: env.TopicArn, metadata: { status: res.status } });
}
