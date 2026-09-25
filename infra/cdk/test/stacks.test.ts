import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildStacks, type MailAppStacks } from "../lib/stacks.js";

function synth(extraContext: Record<string, unknown> = {}): MailAppStacks {
  const app = new App({
    context: {
      envName: "test",
      region: "us-east-1",
      account: "123456789012",
      domainName: "outreach.example.com",
      hostedZoneId: "Z0000000000000000000A",
      sendingDomain: "example.com",
      fromEmail: "outreach@example.com",
      inboundEnabled: true,
      subscribeWebhooks: true,
      alertEmail: "ops@example.com",
      // Skip the Docker asset so the test never needs Docker or the full repo staged.
      imageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/mailapp:test",
      ...extraContext,
    },
  });
  return buildStacks(app, loadConfig(app));
}

describe("MailApp CDK stacks", () => {
  let stacks: MailAppStacks;
  let network: Template;
  let data: Template;
  let messaging: Template;
  let compute: Template;
  let observability: Template;

  beforeAll(() => {
    stacks = synth();
    network = Template.fromStack(stacks.network);
    data = Template.fromStack(stacks.data);
    messaging = Template.fromStack(stacks.messaging);
    compute = Template.fromStack(stacks.compute);
    observability = Template.fromStack(stacks.observability);
  });

  it("creates a VPC without a NAT gateway and three subnet tiers", () => {
    network.resourceCountIs("AWS::EC2::VPC", 1);
    network.resourceCountIs("AWS::EC2::NatGateway", 0);
    network.resourceCountIs("AWS::EC2::Subnet", 6);
    network.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      IpProtocol: "tcp",
      FromPort: 5432,
      ToPort: 5432,
    });
  });

  it("creates an encrypted Postgres 16 instance with backups", () => {
    data.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      EngineVersion: Match.stringLikeRegexp("^16"),
      StorageEncrypted: true,
      BackupRetentionPeriod: 7,
      DBName: "mailapp",
    });
  });

  it("composes a DATABASE_URL secret and generates JWT/APP secrets", () => {
    const dbUrl = Object.values(data.findResources("AWS::SecretsManager::Secret", { Properties: { Name: "mailapp/test/DATABASE_URL" } }))[0];
    expect(dbUrl).toBeDefined();
    expect(JSON.stringify((dbUrl as { Properties: { SecretString: unknown } }).Properties.SecretString)).toContain("postgres://mailapp:");
    data.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "mailapp/test/JWT_SECRET",
      GenerateSecretString: { PasswordLength: 64, ExcludePunctuation: true },
    });
    data.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "mailapp/test/APP_SECRET" });
    data.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "mailapp/test/external" });
  });

  it("creates encrypted, non-public S3 buckets with lifecycle rules", () => {
    data.resourceCountIs("AWS::S3::Bucket", 2);
    data.allResourcesProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    data.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
    data.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 90 })]) },
    });
  });

  it("creates log groups for api, worker and migrate", () => {
    for (const name of ["/mailapp/test/api", "/mailapp/test/worker", "/mailapp/test/migrate"]) {
      data.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: name });
    }
  });

  it("creates the SES configuration set with an SNS event destination for every event type", () => {
    messaging.hasResourceProperties("AWS::SES::ConfigurationSet", {
      Name: "mailapp-test-events",
      ReputationOptions: { ReputationMetricsEnabled: true },
      SendingOptions: { SendingEnabled: true },
      DeliveryOptions: { TlsPolicy: "REQUIRE" },
    });
    messaging.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
      ConfigurationSetName: Match.anyValue(),
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: Match.arrayWith(["send", "delivery", "bounce", "complaint", "reject", "open", "click", "renderingFailure", "deliveryDelay", "subscription"]),
        SnsDestination: { TopicARN: Match.anyValue() },
      },
    });
    messaging.hasResourceProperties("AWS::SNS::Topic", { TopicName: "mailapp-test-ses-events" });
  });

  it("creates a DKIM-signed sending identity and inbound receipt rules when enabled", () => {
    messaging.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: "example.com",
      DkimAttributes: { SigningEnabled: true },
    });
    messaging.hasResourceProperties("AWS::SES::ReceiptRuleSet", { RuleSetName: "mailapp-test-inbound" });
    messaging.hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: Match.objectLike({
        Recipients: ["example.com"],
        Actions: Match.arrayWith([Match.objectLike({ S3Action: Match.objectLike({ ObjectKeyPrefix: "inbound/" }) })]),
      }),
    });
    messaging.hasResourceProperties("AWS::SNS::Topic", { TopicName: "mailapp-test-ses-inbound" });
    // The rule set is activated by an SDK call (Custom::AWS); SES ignores inactive rule sets.
    messaging.resourceCountIs("Custom::AWS", 1);
    expect(JSON.stringify(messaging.findResources("Custom::AWS"))).toContain("setActiveReceiptRuleSet");
  });

  it("receives replies on a dedicated inbound domain when configured", () => {
    const s = synth({ inboundEnabled: true, inboundDomain: "reply.example.com" });
    Template.fromStack(s.messaging).hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: Match.objectLike({ Recipients: ["reply.example.com"] }),
    });
    Template.fromStack(s.compute).hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Environment: Match.arrayWith([{ Name: "SES_INBOUND_DOMAIN", Value: "reply.example.com" }]) }),
      ]),
    });
  });

  it("skips inbound resources when inboundEnabled=false", () => {
    const s = synth({ inboundEnabled: false });
    const t = Template.fromStack(s.messaging);
    t.resourceCountIs("AWS::SES::ReceiptRuleSet", 0);
    t.resourceCountIs("AWS::SES::ReceiptRule", 0);
    t.resourceCountIs("Custom::AWS", 0);
  });

  it("creates the ECS cluster with API (behind HTTPS ALB), worker and migration task definitions", () => {
    compute.hasResourceProperties("AWS::ECS::Cluster", { ClusterName: "mailapp-test" });
    compute.resourceCountIs("AWS::ECS::Service", 2);
    compute.hasResourceProperties("AWS::ECS::Service", { ServiceName: "mailapp-test-api", DesiredCount: 2 });
    compute.hasResourceProperties("AWS::ECS::Service", { ServiceName: "mailapp-test-worker", DesiredCount: 1 });
    compute.resourceCountIs("AWS::ECS::TaskDefinition", 3);
    compute.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: "mailapp-test-migrate",
      ContainerDefinitions: [Match.objectLike({ Command: ["node", "apps/api/dist/db/migrate.js"] })],
    });
    compute.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: "mailapp-test-worker",
      ContainerDefinitions: [Match.objectLike({ Command: ["node", "apps/api/dist/worker.js"] })],
    });
    compute.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443, Protocol: "HTTPS" });
    compute.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: "redirect" })],
    });
    compute.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/healthz",
      TargetType: "ip",
    });
    compute.resourceCountIs("AWS::ApplicationAutoScaling::ScalingPolicy", 0);
    data.hasResourceProperties("AWS::RDS::DBInstance", { MultiAZ: false });
  });

  it("wires every application env var and secret into the API container", () => {
    const required = [
      "NODE_ENV", "PORT", "PUBLIC_BASE_URL", "WEB_ORIGIN", "LLM_PROVIDER", "LLM_MODEL", "AWS_REGION",
      "SES_MODE", "SES_CONFIGURATION_SET", "SES_FROM_EMAIL", "SES_DAILY_CAP", "SES_MAX_SEND_RATE",
      "SES_INBOUND_BUCKET", "SNS_ALLOWED_TOPIC_ARNS", "STORAGE_DRIVER", "STORAGE_S3_BUCKET",
      "CLOUDWATCH_METRICS_ENABLED", "CLOUDWATCH_SES_METRICS_ENABLED", "WORKER_SEND_CONCURRENCY",
    ];
    const apiDef = Object.values(compute.findResources("AWS::ECS::TaskDefinition", { Properties: { Family: "mailapp-test-api" } }))[0] as {
      Properties: { ContainerDefinitions: Array<{ Environment: Array<{ Name: string; Value: unknown }>; Secrets: Array<{ Name: string }> }> };
    };
    expect(apiDef).toBeDefined();
    const container = apiDef.Properties.ContainerDefinitions[0];
    const envNames = container.Environment.map((e) => e.Name);
    expect(envNames).toEqual(expect.arrayContaining(required));
    expect(container.Environment).toEqual(
      expect.arrayContaining([
        { Name: "SES_MODE", Value: "ses" },
        { Name: "SES_CONFIGURATION_SET", Value: "mailapp-test-events" },
        { Name: "PUBLIC_BASE_URL", Value: "https://outreach.example.com" },
      ]),
    );
    expect(container.Secrets.map((x) => x.Name)).toEqual(
      expect.arrayContaining(["DATABASE_URL", "JWT_SECRET", "APP_SECRET", "ANTHROPIC_API_KEY", "IMAP_PASSWORD"]),
    );
  });

  it("grants the task role least-privilege SES / CloudWatch permissions", () => {
    compute.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["ses:SendEmail", "ses:SendRawEmail"],
            Effect: "Allow",
          }),
          Match.objectLike({
            Action: "cloudwatch:PutMetricData",
            Condition: { StringEquals: { "cloudwatch:namespace": "MailApp" } },
          }),
        ]),
      },
    });
    // No wildcard admin actions anywhere in the task role policies.
    const policies = compute.findResources("AWS::IAM::Policy");
    for (const p of Object.values(policies)) {
      const doc = JSON.stringify((p as { Properties: unknown }).Properties);
      expect(doc).not.toMatch(/"Action":"\*"/);
      expect(doc).not.toMatch(/"iam:\*"/);
    }
  });

  it("subscribes the SES event and inbound topics to the API webhooks over HTTPS", () => {
    messaging.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "https",
      Endpoint: "https://outreach.example.com/webhooks/ses/events",
    });
    // The inbound subscription lives in the Compute stack so it is created after the API rollout
    // (the API only confirms topics present in its SNS_ALLOWED_TOPIC_ARNS).
    compute.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "https",
      Endpoint: "https://outreach.example.com/webhooks/ses/inbound",
    });
  });

  it("creates the reputation, availability and app alarms plus a dashboard", () => {
    observability.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "mailapp-test-ses-bounce-rate",
      Namespace: "AWS/SES",
      MetricName: "Reputation.BounceRate",
      Threshold: 0.05,
    });
    observability.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "mailapp-test-ses-complaint-rate",
      MetricName: "Reputation.ComplaintRate",
      Threshold: 0.001,
    });
    observability.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "mailapp-test-worker-down",
      TreatMissingData: "breaching",
      ComparisonOperator: "LessThanThreshold",
    });
    observability.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "mailapp-test-alb-5xx" });
    observability.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "mailapp-test-rds-free-storage" });
    observability.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "mailapp-test-send-failures" });
    expect(Object.keys(observability.findResources("AWS::CloudWatch::Alarm")).length).toBeGreaterThanOrEqual(8);
    observability.hasResourceProperties("AWS::CloudWatch::Dashboard", { DashboardName: "mailapp-test" });
    observability.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "ops@example.com" });
  });

  it("serves plain HTTP and warns when no certificate/domain is configured", () => {
    const s = synth({ domainName: "", hostedZoneId: "", certificateArn: "", inboundEnabled: false });
    const t = Template.fromStack(s.compute);
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 80, Protocol: "HTTP" });
    t.resourceCountIs("AWS::SNS::Subscription", 0);
    const warnings = s.compute.node.metadata.filter((m) => m.type === "aws:cdk:warning");
    expect(warnings.some((w) => String(w.data).includes("plain HTTP"))).toBe(true);
  });

  it("rejects inboundEnabled without an inbound or sending domain", () => {
    expect(() => synth({ sendingDomain: "", inboundDomain: "", inboundEnabled: true })).toThrow(/inboundDomain/);
    expect(() => synth({ sendingDomain: "", inboundDomain: "reply.example.com", inboundEnabled: true })).not.toThrow();
  });
});
