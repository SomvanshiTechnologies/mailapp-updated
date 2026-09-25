import { Annotations, CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MailAppConfig } from "../config.js";
import type { DataStack } from "./data-stack.js";
import type { MessagingStack } from "./messaging-stack.js";
import type { NetworkStack } from "./network-stack.js";

export interface ComputeStackProps extends StackProps {
  config: MailAppConfig;
  network: NetworkStack;
  data: DataStack;
  messaging: MessagingStack;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (…/mailapp) – the Docker build context. */
export const REPO_ROOT = path.resolve(here, "../../..");

/** ECS Fargate: API service behind an ALB, worker service, one-off migration task. */
export class ComputeStack extends Stack {
  readonly cluster: ecs.Cluster;
  readonly apiService: ecsPatterns.ApplicationLoadBalancedFargateService;
  readonly workerService: ecs.FargateService;
  readonly migrationTaskDefinition: ecs.FargateTaskDefinition;
  readonly taskRole: iam.Role;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const { config, network, data, messaging } = props;

    this.cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: `mailapp-${config.envName}`,
      vpc: network.vpc,
      containerInsights: true,
    });

    // ---------- Image ----------
    const image = config.imageUri
      ? ecs.ContainerImage.fromRegistry(config.imageUri)
      : ecs.ContainerImage.fromDockerImageAsset(
          new ecrAssets.DockerImageAsset(this, "AppImage", {
            directory: REPO_ROOT,
            file: "Dockerfile",
            platform: ecrAssets.Platform.LINUX_AMD64,
            exclude: ["**/node_modules", "**/dist", "infra/cdk/cdk.out", ".git"],
          }),
        );

    // ---------- IAM ----------
    this.taskRole = new iam.Role(this, "TaskRole", {
      roleName: `mailapp-${config.envName}-task`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Runtime permissions for the mailapp API and worker",
    });
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SesSend",
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
        conditions: { StringEquals: { "ses:ApiVersion": "2" } },
      }),
    );
    this.taskRole.addToPolicy(
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
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchPutMetrics",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": "MailApp" } },
      }),
    );
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchReadSesMetrics",
        actions: ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics", "cloudwatch:GetMetricStatistics"],
        resources: ["*"],
      }),
    );
    data.storageBucket.grantReadWrite(this.taskRole);
    data.inboundBucket.grantRead(this.taskRole);
    data.inboundBucket.grantDelete(this.taskRole);

    const executionRole = new iam.Role(this, "ExecutionRole", {
      roleName: `mailapp-${config.envName}-execution`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
      ],
    });
    for (const s of [data.databaseUrlSecret, data.jwtSecret, data.appSecret, data.externalSecrets]) {
      s.grantRead(executionRole);
    }

    // ---------- Environment ----------
    const publicBaseUrl = config.publicBaseUrl; // may be empty until the ALB DNS is known
    const environment: Record<string, string> = {
      NODE_ENV: "production",
      PORT: "4000",
      LOG_LEVEL: "info",
      LOG_PRETTY: "false",
      PUBLIC_BASE_URL: publicBaseUrl || "http://localhost:4000",
      WEB_ORIGIN: publicBaseUrl || "http://localhost:4000",
      ACCESS_TOKEN_TTL_MINUTES: "15",
      REFRESH_TOKEN_TTL_DAYS: "14",
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: config.llmModel,
      LLM_RESEARCH_MODEL: config.llmModel,
      LLM_MAX_CONCURRENCY: "3",
      LLM_WEB_SEARCH: "true",
      AWS_REGION: this.region,
      SES_MODE: "ses",
      SES_CONFIGURATION_SET: messaging.configurationSetName,
      SES_FROM_EMAIL: config.fromEmail,
      SES_FROM_NAME: config.fromName,
      SES_REPLY_TO: config.replyTo,
      SES_DAILY_CAP: String(config.sesDailyCap),
      SES_MAX_SEND_RATE: String(config.sesMaxSendRate),
      SES_INBOUND_BUCKET: config.inboundEnabled ? data.inboundBucket.bucketName : "",
      SES_INBOUND_PREFIX: messaging.inboundPrefix,
      SES_INBOUND_DOMAIN: config.inboundEnabled ? config.inboundDomain : "",
      SNS_ALLOWED_TOPIC_ARNS: [messaging.eventsTopic.topicArn, messaging.inboundTopic?.topicArn]
        .filter(Boolean)
        .join(","),
      IMAP_ENABLED: "false",
      IMAP_HOST: "",
      IMAP_PORT: "993",
      IMAP_USER: "",
      IMAP_MAILBOX: "INBOX",
      STORAGE_DRIVER: "s3",
      STORAGE_LOCAL_DIR: "/data/storage",
      STORAGE_S3_BUCKET: data.storageBucket.bucketName,
      STORAGE_S3_PREFIX: `mailapp/${config.envName}/`,
      CLOUDWATCH_METRICS_ENABLED: "true",
      CLOUDWATCH_NAMESPACE: "MailApp",
      CLOUDWATCH_SES_METRICS_ENABLED: "true",
      WORKER_RESEARCH_CONCURRENCY: "2",
      WORKER_DRAFT_CONCURRENCY: "2",
      WORKER_SEND_CONCURRENCY: "2",
      APP_VERSION: process.env.APP_VERSION ?? "1.0.0",
    };
    const secrets: Record<string, ecs.Secret> = {
      DATABASE_URL: ecs.Secret.fromSecretsManager(data.databaseUrlSecret),
      JWT_SECRET: ecs.Secret.fromSecretsManager(data.jwtSecret),
      APP_SECRET: ecs.Secret.fromSecretsManager(data.appSecret),
      ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(data.externalSecrets, "ANTHROPIC_API_KEY"),
      IMAP_PASSWORD: ecs.Secret.fromSecretsManager(data.externalSecrets, "IMAP_PASSWORD"),
    };

    // ---------- API service ----------
    const apiTaskDef = new ecs.FargateTaskDefinition(this, "ApiTaskDef", {
      family: `mailapp-${config.envName}-api`,
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: this.taskRole,
      executionRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    apiTaskDef.addContainer("api", {
      containerName: "api",
      image,
      command: ["node", "apps/api/dist/server.js"],
      environment,
      secrets,
      portMappings: [{ containerPort: 4000, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: data.apiLogGroup, streamPrefix: "api" }),
      healthCheck: {
        command: ["CMD-SHELL", "curl -fsS http://127.0.0.1:4000/healthz || exit 1"],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
      stopTimeout: Duration.seconds(30),
    });

    // Certificate / DNS
    let certificate: certificatemanager.ICertificate | undefined;
    let domainZone: route53.IHostedZone | undefined;
    if (config.domainName && config.hostedZoneId) {
      domainZone = route53.HostedZone.fromHostedZoneAttributes(this, "AppZone", {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.domainName.split(".").slice(-2).join("."),
      });
    }
    if (config.certificateArn) {
      certificate = certificatemanager.Certificate.fromCertificateArn(this, "Cert", config.certificateArn);
    } else if (config.domainName && domainZone) {
      certificate = new certificatemanager.Certificate(this, "Cert", {
        domainName: config.domainName,
        validation: certificatemanager.CertificateValidation.fromDns(domainZone),
      });
    } else {
      Annotations.of(this).addWarning(
        "No certificateArn / hostedZoneId: the ALB will serve plain HTTP. Provide a certificate before going live " +
          "(SNS HTTPS subscriptions and secure cookies need TLS).",
      );
    }

    // The ALB is created here with the security group owned by the network stack so that the
    // ALB -> task ingress rule lives entirely in the network stack (no cross-stack cycle).
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc: network.vpc,
      internetFacing: true,
      // Both "public" and "app" groups are public subnets; an ALB may only use one subnet per AZ.
      vpcSubnets: { subnetGroupName: "public" },
      securityGroup: network.albSecurityGroup,
      idleTimeout: Duration.seconds(120),
    });

    this.apiService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "ApiService", {
      cluster: this.cluster,
      serviceName: `mailapp-${config.envName}-api`,
      taskDefinition: apiTaskDef,
      desiredCount: config.apiDesiredCount,
      loadBalancer: alb,
      openListener: false,
      // No NAT gateway: tasks get a public IP in the "app" subnets and reach ECR / Secrets Manager /
      // SES / Anthropic directly. Inbound is still limited by the security group (ALB -> 4000 only).
      assignPublicIp: true,
      taskSubnets: { subnetGroupName: "app" },
      securityGroups: [network.appSecurityGroup],
      certificate,
      redirectHTTP: !!certificate,
      protocol: certificate ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      sslPolicy: certificate ? elbv2.SslPolicy.RECOMMENDED_TLS : undefined,
      domainName: domainZone ? config.domainName : undefined,
      domainZone,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(60),
      enableExecuteCommand: !config.isProd,
    });
    this.loadBalancer = this.apiService.loadBalancer;
    this.apiService.targetGroup.configureHealthCheck({
      path: "/healthz",
      healthyHttpCodes: "200",
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    this.apiService.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");

    // ---------- Worker service ----------
    const workerTaskDef = new ecs.FargateTaskDefinition(this, "WorkerTaskDef", {
      family: `mailapp-${config.envName}-worker`,
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: this.taskRole,
      executionRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    workerTaskDef.addContainer("worker", {
      containerName: "worker",
      image,
      command: ["node", "apps/api/dist/worker.js"],
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup: data.workerLogGroup, streamPrefix: "worker" }),
      stopTimeout: Duration.seconds(120), // let in-flight sends / LLM calls finish
    });
    this.workerService = new ecs.FargateService(this, "WorkerService", {
      cluster: this.cluster,
      serviceName: `mailapp-${config.envName}-worker`,
      taskDefinition: workerTaskDef,
      desiredCount: config.workerDesiredCount,
      vpcSubnets: { subnetGroupName: "app" },
      securityGroups: [network.appSecurityGroup],
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 100, // never run two copies of a worker replacement concurrently on tiny counts
      enableExecuteCommand: !config.isProd,
    });

    // ---------- Migration task (run manually with `aws ecs run-task`) ----------
    this.migrationTaskDefinition = new ecs.FargateTaskDefinition(this, "MigrateTaskDef", {
      family: `mailapp-${config.envName}-migrate`,
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: this.taskRole,
      executionRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    this.migrationTaskDefinition.addContainer("migrate", {
      containerName: "migrate",
      image,
      command: ["node", "apps/api/dist/db/migrate.js"],
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup: data.migrateLogGroup, streamPrefix: "migrate" }),
    });

    // ---------- SNS -> webhook subscriptions ----------
    if (config.domainName && config.subscribeWebhooks) {
      // Protocol (HTTPS) is inferred from the URL. The API confirms the subscription automatically.
      messaging.eventsTopic.addSubscription(
        new snsSubscriptions.UrlSubscription(`https://${config.domainName}/webhooks/ses/events`),
      );
      if (messaging.inboundTopic) {
        // Created in this stack (not the topic's) and only after the API service has rolled out,
        // because the API rejects confirmations for topics missing from SNS_ALLOWED_TOPIC_ARNS.
        const inboundSub = new sns.Subscription(this, "InboundWebhookSubscription", {
          topic: messaging.inboundTopic,
          protocol: sns.SubscriptionProtocol.HTTPS,
          endpoint: `https://${config.domainName}/webhooks/ses/inbound`,
        });
        inboundSub.node.addDependency(this.apiService.service);
      }
    } else {
      Annotations.of(this).addWarning(
        "SNS HTTPS subscriptions for SES events were not created (needs domainName + subscribeWebhooks=true). " +
          "Redeploy with -c subscribeWebhooks=true once DNS points at the ALB.",
      );
    }

    // ---------- Outputs ----------
    const taskSubnetIds = network.vpc.selectSubnets({ subnetGroupName: "app" }).subnetIds;
    new CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
    new CfnOutput(this, "ApiServiceName", { value: this.apiService.service.serviceName });
    new CfnOutput(this, "WorkerServiceName", { value: this.workerService.serviceName });
    new CfnOutput(this, "LoadBalancerDns", { value: this.apiService.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, "MigrationTaskDefinitionArn", { value: this.migrationTaskDefinition.taskDefinitionArn });
    new CfnOutput(this, "TaskSubnetIds", { value: taskSubnetIds.join(",") });
    new CfnOutput(this, "TaskSecurityGroupId", { value: network.appSecurityGroup.securityGroupId });
    new CfnOutput(this, "RunMigrationsCommand", {
      value: [
        "aws ecs run-task",
        `--cluster ${this.cluster.clusterName}`,
        "--launch-type FARGATE",
        `--task-definition ${this.migrationTaskDefinition.family}`,
        `--network-configuration "awsvpcConfiguration={subnets=[${taskSubnetIds.join(",")}],securityGroups=[${network.appSecurityGroup.securityGroupId}],assignPublicIp=ENABLED}"`,
      ].join(" "),
    });
  }
}
