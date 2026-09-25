import { randomUUID } from "node:crypto";
import type { SesAccountInfo, SesMetricsResponse } from "@mailapp/shared";
import type { AppConfig } from "../../config.js";
import type { SendEmailInput, SendEmailResult, SesGateway, SesIdentity, SuppressedDestination } from "./gateway.js";

/**
 * Dry-run gateway: nothing leaves the process. Every send is recorded in `sent` so tests and
 * the dashboard can inspect it. Addresses containing "bounce@" or "fail@" simulate errors.
 */
export class MockSesGateway implements SesGateway {
  readonly mode = "mock" as const;
  readonly sent: Array<SendEmailInput & { messageId: string; at: Date }> = [];
  readonly suppressed = new Map<string, SuppressedDestination>();

  constructor(private readonly config: AppConfig) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (input.to.startsWith("fail@") || input.to.includes("+fail@")) {
      const err = Object.assign(new Error("Email address is not verified (mock)"), {
        name: "MessageRejected",
        $metadata: { httpStatusCode: 400, requestId: randomUUID() },
      });
      throw err;
    }
    const messageId = `mock-${randomUUID().replace(/-/g, "")}`;
    this.sent.push({ ...input, messageId, at: new Date() });
    return {
      messageId,
      raw: { MessageId: messageId, $metadata: { httpStatusCode: 200, requestId: randomUUID(), attempts: 1 } },
      requestSummary: summarise(input),
    };
  }

  async getAccount(): Promise<SesAccountInfo> {
    return {
      fetchedAt: new Date().toISOString(),
      mode: "mock",
      region: this.config.AWS_REGION,
      sendingEnabled: true,
      productionAccessEnabled: false,
      enforcementStatus: "HEALTHY",
      sendQuota: { max24HourSend: 200, maxSendRate: 1, sentLast24Hours: this.sent.length },
      dedicatedIpAutoWarmupEnabled: false,
      vdmEnabled: false,
      suppressionReasons: ["BOUNCE", "COMPLAINT"],
      details: "Mock SES gateway: no email is actually sent.",
      error: null,
    };
  }

  async putSuppressed(email: string, reason: "BOUNCE" | "COMPLAINT"): Promise<void> {
    this.suppressed.set(email.toLowerCase(), { email: email.toLowerCase(), reason, lastUpdate: new Date().toISOString() });
  }

  async listSuppressed(since?: Date): Promise<SuppressedDestination[]> {
    return [...this.suppressed.values()].filter((s) => !since || new Date(s.lastUpdate) >= since);
  }

  /** Mock: the configured from-address and its domain count as verified. */
  async listIdentities(): Promise<SesIdentity[] | null> {
    const from = this.config.SES_FROM_EMAIL.toLowerCase();
    return [
      { name: from, type: "EMAIL_ADDRESS", verified: true },
      { name: from.split("@")[1] ?? "example.com", type: "DOMAIN", verified: true },
    ];
  }

  async getMetrics(configurationSet: string | null): Promise<SesMetricsResponse> {
    return {
      fetchedAt: new Date().toISOString(),
      enabled: false,
      configurationSet,
      period: 3600,
      series: [],
      error: null,
    };
  }
}

export function summarise(input: SendEmailInput): Record<string, unknown> {
  return {
    from: input.fromName ? `${input.fromName} <${input.from}>` : input.from,
    to: input.to,
    replyTo: input.replyTo,
    subject: input.subject,
    headers: input.headers,
    tags: input.tags,
    configurationSet: input.configurationSet,
    textLength: input.text.length,
    htmlLength: input.html?.length ?? 0,
  };
}
