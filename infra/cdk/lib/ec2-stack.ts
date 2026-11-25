import { Annotations, CfnOutput, RemovalPolicy, SecretValue, Size, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as dlm from "aws-cdk-lib/aws-dlm";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import type { MailAppConfig } from "../config.js";
import type { MessagingStack } from "./messaging-stack.js";
import type { StorageStack } from "./storage-stack.js";

export interface Ec2StackProps extends StackProps {
  config: MailAppConfig;
  storage: StorageStack;
  messaging: MessagingStack;
}

/** Characters excluded from generated passwords so DATABASE_URL never needs URL-encoding. */
const PASSWORD_EXCLUDE = " %+~`#$&*()|[]{}:;<>?!'/@\"\\,=";

const COMPOSE_VERSION = "v2.29.7";
const BUILDX_VERSION = "v0.17.1";

/**
 * Single-instance deployment: one EC2 host runs Postgres, the API, the worker and Caddy (automatic HTTPS)
 * from the repo's Docker image, which is built on the instance from the source uploaded as a CDK asset.
 * Postgres data and uploads live on a separate EBS volume that is snapshotted daily.
 * Access is via SSM Session Manager (no SSH port); SES is reached through the instance role.
 */
export class Ec2Stack extends Stack {
  readonly instance: ec2.Instance;
  readonly elasticIp: ec2.CfnEIP;

  constructor(scope: Construct, id: string, props: Ec2StackProps) {
    super(scope, id, props);
    const { config, storage, messaging } = props;
    const retain = config.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // ---------- Network ----------
    const vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `mailapp-${config.envName}`,
      maxAzs: 1,
      natGateways: 0,
      ipAddresses: ec2.IpAddresses.cidr("10.43.0.0/16"),
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });
    const sg = new ec2.SecurityGroup(this, "Sg", { vpc, description: "mailapp host", allowAllOutbound: true });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP (Let's Encrypt challenge + redirect)");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    // ---------- Secrets (read by the instance at first boot) ----------
    const generated = (name: string, description: string, length: number) =>
      new secretsmanager.Secret(this, name, {
        secretName: `mailapp/${config.envName}/${name}`,
        description,
        generateSecretString: { passwordLength: length, excludeCharacters: PASSWORD_EXCLUDE },
        removalPolicy: retain,
      });
    const dbPassword = generated("DbPassword", "Postgres password for the mailapp database", 32);
    const jwtSecret = generated("JwtSecret", "JWT signing secret", 64);
    const appSecret = generated("AppSecret", "HMAC / encryption secret", 64);
    const adminPassword = generated("AdminPassword", `Initial password for ${config.seedAdminEmail}`, 20);
    const externalSecrets = new secretsmanager.Secret(this, "ExternalSecrets", {
      secretName: `mailapp/${config.envName}/external`,
      description: "Third-party credentials: ANTHROPIC_API_KEY, IMAP_PASSWORD. Set real values after deploy.",
      secretObjectValue: {
        ANTHROPIC_API_KEY: SecretValue.unsafePlainText("REPLACE_ME"),
        IMAP_PASSWORD: SecretValue.unsafePlainText(""),
      },
      removalPolicy: retain,
    });

    // ---------- Application source ----------
    const asset = new s3assets.Asset(this, "AppSource", {
      path: fileURLToPath(new URL("../../..", import.meta.url)),
      exclude: [
        ".git",
        ".claude",
        ".env",
        ".env.*",
        "!.env.example",
        "**/node_modules",
        "**/dist",
        "**/cdk.out",
        "**/*.log",
        // Root-level and API runtime folders only: apps/api/src/modules/storage is source.
        "storage",
        "apps/api/storage",
        "docs",
        "tools",
      ],
    });

    // ---------- IAM ----------
    const role = new iam.Role(this, "Role", {
      roleName: `mailapp-${config.envName}-ec2`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "SesSend",
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
        conditions: { StringEquals: { "ses:ApiVersion": "2" } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "SesAccountAndSuppression",
        actions: [
          "ses:GetAccount",
          "ses:GetConfigurationSet",
          "ses:ListEmailIdentities",
          "ses:GetEmailIdentity",
          "ses:PutSuppressedDestination",
          "ses:GetSuppressedDestination",
          "ses:ListSuppressedDestinations",
          "ses:DeleteSuppressedDestination",
          "ses:BatchGetMetricData",
        ],
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchPutMetrics",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": "MailApp" } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchReadSesMetrics",
        actions: ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics", "cloudwatch:GetMetricStatistics"],
        resources: ["*"],
      }),
    );
    storage.inboundBucket.grantRead(role);
    storage.inboundBucket.grantDelete(role);
    asset.grantRead(role);
    for (const s of [dbPassword, jwtSecret, appSecret, adminPassword, externalSecrets]) s.grantRead(role);

    // ---------- Host ----------
    const publicUrl = (ip: string) => (config.domainName ? `https://${config.domainName}` : `http://${ip}`);
    this.elasticIp = new ec2.CfnEIP(this, "Eip", { domain: "vpc" });
    const baseUrl = publicUrl(this.elasticIp.ref);

    const env: Record<string, string> = {
      NODE_ENV: "production",
      PORT: "4000",
      LOG_LEVEL: "info",
      PUBLIC_BASE_URL: baseUrl,
      WEB_ORIGIN: baseUrl,
      AWS_REGION: this.region,
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: config.llmModel,
      LLM_RESEARCH_MODEL: config.llmModel,
      LLM_MAX_CONCURRENCY: "3",
      LLM_WEB_SEARCH: "true",
      SES_MODE: "ses",
      SES_CONFIGURATION_SET: messaging.configurationSetName,
      SES_FROM_EMAIL: config.fromEmail,
      SES_FROM_NAME: config.fromName,
      SES_REPLY_TO: config.replyTo,
      SES_DAILY_CAP: String(config.sesDailyCap),
      SES_MAX_SEND_RATE: String(config.sesMaxSendRate),
      SES_INBOUND_BUCKET: config.inboundEnabled ? storage.inboundBucket.bucketName : "",
      SES_INBOUND_PREFIX: messaging.inboundPrefix,
      SES_INBOUND_DOMAIN: config.inboundEnabled ? config.inboundDomain : "",
      SNS_ALLOWED_TOPIC_ARNS: [messaging.eventsTopic.topicArn, messaging.inboundTopic?.topicArn]
        .filter(Boolean)
        .join(","),
      IMAP_ENABLED: "false",
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: "/data/storage",
      CLOUDWATCH_METRICS_ENABLED: "true",
      CLOUDWATCH_NAMESPACE: "MailApp",
      CLOUDWATCH_SES_METRICS_ENABLED: "true",
      SEED_ADMIN_EMAIL: config.seedAdminEmail,
    };
    const envLines = Object.entries(env).map(([k, v]) => `${k}=${v}`);

    const compose = `services:
  postgres:
    image: public.ecr.aws/docker/library/postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: mailapp
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: mailapp
    volumes:
      - /data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mailapp -d mailapp"]
      interval: 5s
      timeout: 3s
      retries: 20
  migrate:
    image: mailapp:local
    command: ["sh", "-c", "node apps/api/dist/db/migrate.js && node apps/api/dist/db/seed.js"]
    env_file: .env
    restart: "no"
    depends_on:
      postgres:
        condition: service_healthy
  api:
    image: mailapp:local
    command: ["node", "apps/api/dist/server.js"]
    env_file: .env
    restart: unless-stopped
    volumes:
      - /data/storage:/data/storage
    depends_on:
      migrate:
        condition: service_completed_successfully
  worker:
    image: mailapp:local
    command: ["node", "apps/api/dist/worker.js"]
    env_file: .env
    restart: unless-stopped
    volumes:
      - /data/storage:/data/storage
    depends_on:
      migrate:
        condition: service_completed_successfully
  caddy:
    image: public.ecr.aws/docker/library/caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - /data/caddy:/data
    depends_on:
      - api
`;
    // Without a domain Caddy serves plain HTTP on the Elastic IP; with one it obtains a Let's Encrypt certificate.
    const caddyfile = config.domainName
      ? `${config.domainName} {\n  reverse_proxy api:4000\n}\n`
      : `:80 {\n  reverse_proxy api:4000\n}\n`;

    const secretValue = (s: secretsmanager.ISecret) =>
      `$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${s.secretArn} --query SecretString --output text)`;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -eo pipefail",
      "exec > >(tee -a /var/log/mailapp-bootstrap.log) 2>&1",
      // Swap: the image build (vite + tsc) is memory hungry.
      "fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile",
      'echo "/swapfile none swap sw 0 0" >> /etc/fstab',
      "dnf install -y docker unzip",
      "systemctl enable --now docker",
      'ARCH=$(uname -m); BX=amd64; [ "$ARCH" = aarch64 ] && BX=arm64',
      "mkdir -p /usr/local/lib/docker/cli-plugins",
      `curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-$ARCH" -o /usr/local/lib/docker/cli-plugins/docker-compose`,
      `curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-$BX" -o /usr/local/lib/docker/cli-plugins/docker-buildx`,
      "chmod +x /usr/local/lib/docker/cli-plugins/*",
      // Data volume (attached as /dev/sdf, shows up as nvme1n1 on Nitro instances).
      "DEV=",
      "for i in $(seq 1 60); do for d in /dev/nvme1n1 /dev/sdf /dev/xvdf; do [ -b $d ] && DEV=$d && break; done; [ -n \"$DEV\" ] && break; sleep 5; done",
      '[ -n "$DEV" ] || { echo "data volume not attached"; exit 1; }',
      'blkid "$DEV" || mkfs.xfs "$DEV"',
      "mkdir -p /data",
      'UUID=$(blkid -s UUID -o value "$DEV")',
      'grep -q "$UUID" /etc/fstab || echo "UUID=$UUID /data xfs defaults,nofail 0 2" >> /etc/fstab',
      "mount -a",
      "mkdir -p /data/postgres /data/storage /data/caddy /opt/mailapp",
      "chown 1001:1001 /data/storage",
      // Compose project.
      "cat > /opt/mailapp/docker-compose.yml <<'MAILAPP_COMPOSE_EOF'",
      ...compose.trimEnd().split("\n"),
      "MAILAPP_COMPOSE_EOF",
      "cat > /opt/mailapp/Caddyfile <<'MAILAPP_CADDY_EOF'",
      ...caddyfile.trimEnd().split("\n"),
      "MAILAPP_CADDY_EOF",
      // Environment file: static settings plus secrets fetched from Secrets Manager.
      "umask 077",
      "cat > /opt/mailapp/.env <<'MAILAPP_ENV_EOF'",
      ...envLines,
      "MAILAPP_ENV_EOF",
      `DB_PASSWORD=${secretValue(dbPassword)}`,
      `echo "DB_PASSWORD=$DB_PASSWORD" >> /opt/mailapp/.env`,
      `echo "DATABASE_URL=postgres://mailapp:$DB_PASSWORD@postgres:5432/mailapp" >> /opt/mailapp/.env`,
      `echo "JWT_SECRET=${secretValue(jwtSecret)}" >> /opt/mailapp/.env`,
      `echo "APP_SECRET=${secretValue(appSecret)}" >> /opt/mailapp/.env`,
      `echo "SEED_ADMIN_PASSWORD=${secretValue(adminPassword)}" >> /opt/mailapp/.env`,
      `EXT=${secretValue(externalSecrets)}`,
      `echo "ANTHROPIC_API_KEY=$(echo "$EXT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["ANTHROPIC_API_KEY"])')" >> /opt/mailapp/.env`,
      `echo "IMAP_PASSWORD=$(echo "$EXT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["IMAP_PASSWORD"])')" >> /opt/mailapp/.env`,
      // Update script: also used for the first deployment. Usage: update.sh <s3://asset-url>
      "cat > /opt/mailapp/update.sh <<'MAILAPP_UPDATE_EOF'",
      "#!/bin/bash",
      "set -euo pipefail",
      'URL="${1:?usage: update.sh s3://bucket/key.zip}"',
      "rm -rf /opt/mailapp/src /tmp/mailapp-src.zip",
      'aws s3 cp "$URL" /tmp/mailapp-src.zip',
      "mkdir -p /opt/mailapp/src && unzip -q /tmp/mailapp-src.zip -d /opt/mailapp/src",
      "DOCKER_BUILDKIT=1 docker build -t mailapp:local /opt/mailapp/src",
      "cd /opt/mailapp && docker compose up -d --remove-orphans",
      "MAILAPP_UPDATE_EOF",
      "chmod +x /opt/mailapp/update.sh",
      `/opt/mailapp/update.sh ${asset.s3ObjectUrl}`,
    );

    this.instance = new ec2.Instance(this, "Instance", {
      instanceName: `mailapp-${config.envName}`,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(config.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      userData,
      // New app versions go through update.sh, never by replacing the host.
      userDataCausesReplacement: false,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(20, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }),
        },
      ],
    });
    new ec2.CfnEIPAssociation(this, "EipAssociation", {
      allocationId: this.elasticIp.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    // ---------- Data volume + daily snapshots ----------
    const dataVolume = new ec2.Volume(this, "DataVolume", {
      availabilityZone: vpc.availabilityZones[0]!,
      size: Size.gibibytes(config.dataVolumeGb),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: config.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    Tags.of(dataVolume).add("mailapp-backup", config.envName);
    const attachment = new ec2.CfnVolumeAttachment(this, "DataAttachment", {
      device: "/dev/sdf",
      instanceId: this.instance.instanceId,
      volumeId: dataVolume.volumeId,
    });
    // The instance's first boot waits for the volume, so make sure CFN creates the attachment promptly.
    this.instance.node.addDependency(dataVolume);
    attachment.node.addDependency(this.instance);

    const dlmRole = new iam.Role(this, "DlmRole", {
      assumedBy: new iam.ServicePrincipal("dlm.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSDataLifecycleManagerServiceRole")],
    });
    new dlm.CfnLifecyclePolicy(this, "DailySnapshots", {
      description: `mailapp-${config.envName} data volume, daily, keep 7`,
      state: "ENABLED",
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        resourceTypes: ["VOLUME"],
        targetTags: [{ key: "mailapp-backup", value: config.envName }],
        schedules: [
          {
            name: "daily",
            createRule: { interval: 24, intervalUnit: "HOURS", times: ["20:00"] },
            retainRule: { count: 7 },
            copyTags: true,
          },
        ],
      },
    });

    // ---------- SNS -> webhook subscriptions ----------
    if (config.domainName && config.subscribeWebhooks) {
      messaging.eventsTopic.addSubscription(
        new snsSubscriptions.UrlSubscription(`https://${config.domainName}/webhooks/ses/events`),
      );
      if (messaging.inboundTopic) {
        const inboundSub = new sns.Subscription(this, "InboundWebhookSubscription", {
          topic: messaging.inboundTopic,
          protocol: sns.SubscriptionProtocol.HTTPS,
          endpoint: `https://${config.domainName}/webhooks/ses/inbound`,
        });
        inboundSub.node.addDependency(this.instance);
      }
    } else {
      Annotations.of(this).addWarning(
        "SNS HTTPS subscriptions for SES events were not created (needs domainName + subscribeWebhooks=true). " +
          "Redeploy with -c subscribeWebhooks=true once DNS points at the Elastic IP and the app answers on HTTPS.",
      );
    }

    // ---------- Outputs ----------
    new CfnOutput(this, "ElasticIp", {
      value: this.elasticIp.ref,
      description: config.domainName ? `Create DNS: ${config.domainName} A <this IP>` : "Public IP of the app (http)",
    });
    new CfnOutput(this, "AppUrl", { value: baseUrl });
    new CfnOutput(this, "InstanceId", { value: this.instance.instanceId });
    new CfnOutput(this, "ShellCommand", { value: `aws ssm start-session --target ${this.instance.instanceId}` });
    new CfnOutput(this, "BootstrapLogCommand", {
      value: `aws ssm start-session --target ${this.instance.instanceId} (then: sudo tail -f /var/log/mailapp-bootstrap.log)`,
    });
    new CfnOutput(this, "UpdateAppCommand", {
      value: `aws ssm send-command --instance-ids ${this.instance.instanceId} --document-name AWS-RunShellScript --parameters 'commands=["/opt/mailapp/update.sh ${asset.s3ObjectUrl}"]'`,
      description: "Roll out the version of the source uploaded by the latest cdk deploy",
    });
    new CfnOutput(this, "AdminEmail", { value: config.seedAdminEmail });
    new CfnOutput(this, "AdminPasswordSecret", {
      value: adminPassword.secretName,
      description: "aws secretsmanager get-secret-value --secret-id <this> --query SecretString --output text",
    });
    new CfnOutput(this, "ExternalSecretsName", {
      value: externalSecrets.secretName,
      description: "Put the real ANTHROPIC_API_KEY here, then restart the app (docker compose up -d --force-recreate)",
    });
  }
}
