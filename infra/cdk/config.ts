import type { App } from "aws-cdk-lib";

/**
 * Deployment configuration, read from CDK context (`cdk.json` → "context", or `-c key=value`).
 * Every key has a safe default so `cdk synth` works with no arguments.
 */
export interface MailAppConfig {
  /** Logical environment name used in resource names/tags (e.g. prod, staging). */
  envName: string;
  region: string;
  /** AWS account id. Empty → environment-agnostic stacks. */
  account: string;
  /** Public DNS name of the dashboard/API (e.g. outreach.example.com). Empty → HTTP-only ALB DNS name. */
  domainName: string;
  /** Route 53 hosted zone id for domainName. Enables DNS-validated certificate + A record. */
  hostedZoneId: string;
  /** Existing ACM certificate ARN (same region as the ALB). Takes precedence over hostedZoneId. */
  certificateArn: string;
  /** Domain verified in SES for sending (Easy DKIM). Empty → identity not managed by CDK. */
  sendingDomain: string;
  fromEmail: string;
  fromName: string;
  replyTo: string;
  /** Create SES receipt rule set + inbound bucket notification topic. */
  inboundEnabled: boolean;
  /**
   * Domain SES receives replies for (its MX must point at inbound-smtp.<region>.amazonaws.com).
   * Usually a subdomain such as reply.example.com so the main domain's mailboxes keep working.
   * Empty → sendingDomain.
   */
  inboundDomain: string;
  /** Email address subscribed to the alarms topic. */
  alertEmail: string;
  /** RDS instance class, e.g. t4g.small. */
  dbInstanceClass: string;
  apiDesiredCount: number;
  workerDesiredCount: number;
  /** Pre-built image URI (ECR). Empty → build from the repo Dockerfile as a CDK asset. */
  imageUri: string;
  /**
   * Create the SNS HTTPS subscriptions to the webhooks. SNS validates the endpoint at creation
   * time, so enable this only once the ALB is up and DNS for domainName points at it.
   */
  subscribeWebhooks: boolean;
  llmModel: string;
  sesDailyCap: number;
  sesMaxSendRate: number;
  /** Derived: true when envName === "prod". */
  isProd: boolean;
  /** Derived: base URL of the API. */
  publicBaseUrl: string;
}

function str(app: App, key: string, fallback = ""): string {
  const v = app.node.tryGetContext(key);
  if (v === undefined || v === null) return fallback;
  return String(v).trim();
}
function num(app: App, key: string, fallback: number): number {
  const v = app.node.tryGetContext(key);
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Context "${key}" must be a number, got "${v}"`);
  return n;
}
function bool(app: App, key: string, fallback: boolean): boolean {
  const v = app.node.tryGetContext(key);
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  return ["true", "1", "yes"].includes(String(v).toLowerCase());
}

export function loadConfig(app: App): MailAppConfig {
  const envName = str(app, "envName", "prod");
  const domainName = str(app, "domainName");
  const cfg: MailAppConfig = {
    envName,
    region: str(app, "region", process.env.CDK_DEFAULT_REGION ?? "us-east-1"),
    account: str(app, "account", process.env.CDK_DEFAULT_ACCOUNT ?? ""),
    domainName,
    hostedZoneId: str(app, "hostedZoneId"),
    certificateArn: str(app, "certificateArn"),
    sendingDomain: str(app, "sendingDomain"),
    fromEmail: str(app, "fromEmail", "outreach@example.com"),
    fromName: str(app, "fromName", "Outreach Team"),
    replyTo: str(app, "replyTo"),
    inboundEnabled: bool(app, "inboundEnabled", false),
    inboundDomain: str(app, "inboundDomain"),
    alertEmail: str(app, "alertEmail"),
    dbInstanceClass: str(app, "dbInstanceClass", "t4g.small"),
    apiDesiredCount: num(app, "apiDesiredCount", 2),
    workerDesiredCount: num(app, "workerDesiredCount", 1),
    imageUri: str(app, "imageUri"),
    subscribeWebhooks: bool(app, "subscribeWebhooks", false),
    llmModel: str(app, "llmModel", "claude-opus-5"),
    sesDailyCap: num(app, "sesDailyCap", 2000),
    sesMaxSendRate: num(app, "sesMaxSendRate", 5),
    isProd: envName === "prod",
    publicBaseUrl: domainName ? `https://${domainName}` : "",
  };
  if (cfg.inboundEnabled && !cfg.inboundDomain && !cfg.sendingDomain) {
    throw new Error('Context "inboundEnabled" requires "inboundDomain" or "sendingDomain" (receipt rules need a recipient domain).');
  }
  if (!cfg.inboundDomain) cfg.inboundDomain = cfg.sendingDomain;
  if (!/^[a-z0-9-]+$/.test(cfg.envName)) {
    throw new Error(`Context "envName" must match [a-z0-9-]+, got "${cfg.envName}"`);
  }
  return cfg;
}
