import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
  type StandardUnit,
} from "@aws-sdk/client-cloudwatch";
import type { Logger } from "./logger.js";

export type MetricName =
  | "emails_sent"
  | "send_failures"
  | "send_rate_limited"
  | "llm_calls"
  | "llm_failures"
  | "llm_latency_ms"
  | "llm_input_tokens"
  | "llm_output_tokens"
  | "research_completed"
  | "research_failures"
  | "drafts_created"
  | "drafts_rejected_by_validator"
  | "drafts_approved"
  | "drafts_rejected_by_reviewer"
  | "followups_scheduled"
  | "events_ingested"
  | "bounces"
  | "complaints"
  | "replies"
  | "replies_forwarded"
  | "imap_messages"
  | "unsubscribes"
  | "resubscribes"
  | "webhook_signature_failures"
  | "queue_depth"
  | "job_failures";

interface Buffered {
  name: MetricName;
  value: number;
  unit: StandardUnit;
  dimensions: Record<string, string>;
  at: Date;
}

export interface MetricsSink {
  emit(name: MetricName, value?: number, dimensions?: Record<string, string>, unit?: StandardUnit): void;
  timing(name: MetricName, ms: number, dimensions?: Record<string, string>): void;
  flush(): Promise<void>;
  snapshot(): Record<string, number>;
}

/**
 * Buffered CloudWatch metrics. Counters are also kept in-memory so the dashboard
 * can show process-local totals even when CloudWatch is disabled.
 */
export class Metrics implements MetricsSink {
  private buffer: Buffered[] = [];
  private totals: Record<string, number> = {};
  private client: CloudWatchClient | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: {
      enabled: boolean;
      namespace: string;
      region: string;
      service: string;
      logger: Logger;
      flushIntervalMs?: number;
      client?: CloudWatchClient;
    },
  ) {
    this.client = opts.enabled ? (opts.client ?? new CloudWatchClient({ region: opts.region })) : null;
    if (opts.enabled && (opts.flushIntervalMs ?? 60_000) > 0) {
      this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 60_000);
      this.timer.unref();
    }
  }

  emit(name: MetricName, value = 1, dimensions: Record<string, string> = {}, unit: StandardUnit = "Count"): void {
    this.totals[name] = (this.totals[name] ?? 0) + value;
    if (!this.client) return;
    this.buffer.push({ name, value, unit, dimensions, at: new Date() });
    if (this.buffer.length >= 500) void this.flush();
  }

  timing(name: MetricName, ms: number, dimensions: Record<string, string> = {}): void {
    this.emit(name, ms, dimensions, "Milliseconds");
  }

  snapshot(): Record<string, number> {
    return { ...this.totals };
  }

  async flush(): Promise<void> {
    if (!this.client || this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    const data: MetricDatum[] = batch.map((b) => ({
      MetricName: b.name,
      Value: b.value,
      Unit: b.unit,
      Timestamp: b.at,
      Dimensions: [
        { Name: "Service", Value: this.opts.service },
        ...Object.entries(b.dimensions).map(([Name, Value]) => ({ Name, Value })),
      ].slice(0, 30),
    }));
    // CloudWatch accepts max 1000 datums per call (and 1MB); chunk conservatively.
    for (let i = 0; i < data.length; i += 500) {
      try {
        await this.client.send(
          new PutMetricDataCommand({ Namespace: this.opts.namespace, MetricData: data.slice(i, i + 500) }),
        );
      } catch (err) {
        this.opts.logger.warn({ err }, "cloudwatch PutMetricData failed");
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

/** No-op sink for tests. */
export class NoopMetrics implements MetricsSink {
  totals: Record<string, number> = {};
  emit(name: MetricName, value = 1): void {
    this.totals[name] = (this.totals[name] ?? 0) + value;
  }
  timing(name: MetricName, ms: number): void {
    this.emit(name, ms);
  }
  async flush(): Promise<void> {}
  snapshot(): Record<string, number> {
    return { ...this.totals };
  }
}
