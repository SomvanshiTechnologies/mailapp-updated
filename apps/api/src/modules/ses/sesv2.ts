import {
  GetAccountCommand,
  ListEmailIdentitiesCommand,
  ListSuppressedDestinationsCommand,
  PutSuppressedDestinationCommand,
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2";
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import type { SesAccountInfo, SesMetricsResponse } from "@mailapp/shared";
import type { AppConfig } from "../../config.js";
import type { Logger } from "../../observability/logger.js";
import type { SendEmailInput, SendEmailResult, SesGateway, SesIdentity, SuppressedDestination } from "./gateway.js";
import { summarise } from "./mock.js";

const SES_METRICS = ["Send", "Delivery", "Bounce", "Complaint", "Reject", "Open", "Click", "RenderingFailure", "DeliveryDelay"];

export class SesV2Gateway implements SesGateway {
  readonly mode = "ses" as const;
  private readonly ses: SESv2Client;
  private readonly cw: CloudWatchClient;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    clients?: { ses?: SESv2Client; cw?: CloudWatchClient },
  ) {
    this.ses = clients?.ses ?? new SESv2Client({ region: config.AWS_REGION, maxAttempts: 4 });
    this.cw = clients?.cw ?? new CloudWatchClient({ region: config.AWS_REGION });
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const cmd: SendEmailCommandInput = {
      FromEmailAddress: input.fromName ? `${sanitizeName(input.fromName)} <${input.from}>` : input.from,
      Destination: { ToAddresses: [input.to] },
      ReplyToAddresses: input.replyTo ? [input.replyTo] : undefined,
      ConfigurationSetName: input.configurationSet || undefined,
      EmailTags: Object.entries(input.tags).map(([Name, Value]) => ({ Name, Value: sanitizeTag(Value) })),
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: input.text, Charset: "UTF-8" },
            ...(input.html ? { Html: { Data: input.html, Charset: "UTF-8" } } : {}),
          },
          Headers: Object.entries(input.headers).map(([Name, Value]) => ({ Name, Value })),
        },
      },
    };
    const res = await this.ses.send(new SendEmailCommand(cmd));
    if (!res.MessageId) throw new Error("SES returned no MessageId");
    return {
      messageId: res.MessageId,
      raw: { MessageId: res.MessageId, $metadata: res.$metadata as unknown as Record<string, unknown> },
      requestSummary: summarise(input),
    };
  }

  async getAccount(): Promise<SesAccountInfo> {
    const base: SesAccountInfo = {
      fetchedAt: new Date().toISOString(),
      mode: "ses",
      region: this.config.AWS_REGION,
      sendingEnabled: false,
      productionAccessEnabled: false,
      enforcementStatus: null,
      sendQuota: null,
      dedicatedIpAutoWarmupEnabled: null,
      vdmEnabled: null,
      suppressionReasons: [],
      details: null,
      error: null,
    };
    try {
      const res = await this.ses.send(new GetAccountCommand({}));
      return {
        ...base,
        sendingEnabled: res.SendingEnabled ?? false,
        productionAccessEnabled: res.ProductionAccessEnabled ?? false,
        enforcementStatus: res.EnforcementStatus ?? null,
        sendQuota: res.SendQuota
          ? {
              max24HourSend: res.SendQuota.Max24HourSend ?? 0,
              maxSendRate: res.SendQuota.MaxSendRate ?? 0,
              sentLast24Hours: res.SendQuota.SentLast24Hours ?? 0,
            }
          : null,
        dedicatedIpAutoWarmupEnabled: res.DedicatedIpAutoWarmupEnabled ?? null,
        vdmEnabled: res.VdmAttributes?.VdmEnabled === "ENABLED",
        suppressionReasons: res.SuppressionAttributes?.SuppressedReasons ?? [],
        details: res.Details ? JSON.stringify(res.Details) : null,
      };
    } catch (err) {
      this.logger.warn({ err }, "ses GetAccount failed");
      return { ...base, error: (err as Error).message };
    }
  }

  async putSuppressed(email: string, reason: "BOUNCE" | "COMPLAINT"): Promise<void> {
    await this.ses.send(new PutSuppressedDestinationCommand({ EmailAddress: email, Reason: reason }));
  }

  async listIdentities(): Promise<SesIdentity[] | null> {
    try {
      const out: SesIdentity[] = [];
      let token: string | undefined;
      do {
        const res = await this.ses.send(new ListEmailIdentitiesCommand({ NextToken: token, PageSize: 100 }));
        for (const i of res.EmailIdentities ?? []) {
          if (i.IdentityName) out.push({ name: i.IdentityName, type: i.IdentityType ?? "", verified: i.VerificationStatus === "SUCCESS" || i.SendingEnabled === true });
        }
        token = res.NextToken;
      } while (token);
      return out;
    } catch (err) {
      this.logger.warn({ err }, "ses ListEmailIdentities failed");
      return null;
    }
  }

  async listSuppressed(since?: Date): Promise<SuppressedDestination[]> {
    const out: SuppressedDestination[] = [];
    let token: string | undefined;
    do {
      const res = await this.ses.send(
        new ListSuppressedDestinationsCommand({ StartDate: since, NextToken: token, PageSize: 1000 }),
      );
      for (const d of res.SuppressedDestinationSummaries ?? []) {
        if (d.EmailAddress) {
          out.push({ email: d.EmailAddress, reason: d.Reason ?? "UNKNOWN", lastUpdate: d.LastUpdateTime?.toISOString() ?? "" });
        }
      }
      token = res.NextToken;
    } while (token);
    return out;
  }

  async getMetrics(configurationSet: string | null, hours: number): Promise<SesMetricsResponse> {
    const period = hours <= 24 ? 3600 : 86_400;
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3_600_000);
    const base: SesMetricsResponse = {
      fetchedAt: end.toISOString(),
      enabled: this.config.CLOUDWATCH_SES_METRICS_ENABLED,
      configurationSet,
      period,
      series: [],
      error: null,
    };
    if (!this.config.CLOUDWATCH_SES_METRICS_ENABLED) return base;
    const queries: MetricDataQuery[] = SES_METRICS.map((m, i) => ({
      Id: `m${i}`,
      Label: m,
      MetricStat: {
        Metric: {
          Namespace: "AWS/SES",
          MetricName: m,
          Dimensions: configurationSet ? [{ Name: "ses:configuration-set", Value: configurationSet }] : undefined,
        },
        Period: period,
        Stat: "Sum",
      },
      ReturnData: true,
    }));
    try {
      const res = await this.cw.send(new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: start, EndTime: end }));
      const series = (res.MetricDataResults ?? []).map((r) => ({
        metric: r.Label ?? r.Id ?? "",
        points: (r.Timestamps ?? [])
          .map((t, i) => ({ timestamp: t.toISOString(), value: r.Values?.[i] ?? 0 }))
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      }));
      return { ...base, series };
    } catch (err) {
      this.logger.warn({ err }, "cloudwatch GetMetricData failed");
      return { ...base, error: (err as Error).message };
    }
  }
}

function sanitizeTag(v: string): string {
  return v.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256);
}

function sanitizeName(v: string): string {
  return `"${v.replace(/["\r\n]/g, "")}"`;
}
