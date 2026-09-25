import type { SesAccountInfo, SesMetricsResponse } from "@mailapp/shared";
import type { AppConfig } from "../../config.js";
import type { Logger } from "../../observability/logger.js";

export interface SendEmailInput {
  from: string;
  fromName?: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  /** null sends a text-only message. */
  html: string | null;
  /** Extra RFC 5322 headers (List-Unsubscribe, In-Reply-To, References, ...). */
  headers: Record<string, string>;
  /** SES message tags (become event dimensions). Values: [a-zA-Z0-9_-]. */
  tags: Record<string, string>;
  configurationSet?: string;
}

export interface SendEmailResult {
  messageId: string;
  /** Full SES response (including $metadata) for the audit trail. */
  raw: Record<string, unknown>;
  /** What we sent, minus the body, for the audit trail. */
  requestSummary: Record<string, unknown>;
}

export interface SuppressedDestination {
  email: string;
  reason: string;
  lastUpdate: string;
}

export interface SesIdentity {
  name: string;
  type: "EMAIL_ADDRESS" | "DOMAIN" | "MANAGED_DOMAIN" | string;
  verified: boolean;
}

export interface SesGateway {
  readonly mode: "ses" | "mock";
  send(input: SendEmailInput): Promise<SendEmailResult>;
  getAccount(): Promise<SesAccountInfo>;
  putSuppressed(email: string, reason: "BOUNCE" | "COMPLAINT"): Promise<void>;
  listSuppressed(since?: Date): Promise<SuppressedDestination[]>;
  getMetrics(configurationSet: string | null, hours: number): Promise<SesMetricsResponse>;
  /** Verified identities in the account, or null when the lookup is not possible. */
  listIdentities(): Promise<SesIdentity[] | null>;
}

export function createSesGateway(config: AppConfig, logger: Logger): SesGateway {
  if (config.SES_MODE === "ses") return new SesV2Gateway(config, logger);
  return new MockSesGateway(config);
}

import { SesV2Gateway } from "./sesv2.js";
import { MockSesGateway } from "./mock.js";
