import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { MailAppConfig } from "../config.js";
import type { NetworkStack } from "./network-stack.js";

export interface DataStackProps extends StackProps {
  config: MailAppConfig;
  network: NetworkStack;
}

/** Characters excluded from generated passwords so DATABASE_URL never needs URL-encoding. */
const PASSWORD_EXCLUDE = " %+~`#$&*()|[]{}:;<>?!'/@\"\\,=";

/** RDS PostgreSQL, Secrets Manager secrets, S3 buckets and CloudWatch log groups. */
export class DataStack extends Stack {
  readonly database: rds.DatabaseInstance;
  readonly dbCredentialsSecret: secretsmanager.ISecret;
  /** Secret whose plain string value is a full `postgres://...` URL. */
  readonly databaseUrlSecret: secretsmanager.Secret;
  readonly jwtSecret: secretsmanager.Secret;
  readonly appSecret: secretsmanager.Secret;
  /** JSON secret with ANTHROPIC_API_KEY and IMAP_PASSWORD keys (operator fills in values). */
  readonly externalSecrets: secretsmanager.Secret;
  readonly storageBucket: s3.Bucket;
  readonly inboundBucket: s3.Bucket;
  readonly apiLogGroup: logs.LogGroup;
  readonly workerLogGroup: logs.LogGroup;
  readonly migrateLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, network } = props;
    const retain = config.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const dbName = "mailapp";
    const dbUser = "mailapp";

    // ---------- Database ----------
    const parameterGroup = new rds.ParameterGroup(this, "DbParams", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      parameters: {
        // pg-boss and the API keep pooled connections; make sure slow LLM-bound transactions surface in logs
        log_min_duration_statement: "2000",
        "rds.force_ssl": "1",
      },
    });

    this.database = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: new ec2.InstanceType(config.dbInstanceClass),
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.dbSecurityGroup],
      databaseName: dbName,
      credentials: rds.Credentials.fromGeneratedSecret(dbUser, {
        secretName: `mailapp/${config.envName}/db-credentials`,
        excludeCharacters: PASSWORD_EXCLUDE,
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false, // internal tool: a single-AZ instance is enough
      backupRetention: Duration.days(7),
      preferredBackupWindow: "02:00-03:00",
      preferredMaintenanceWindow: "Sun:03:30-Sun:04:30",
      deletionProtection: config.isProd,
      removalPolicy: config.isProd ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      enablePerformanceInsights: true,
      parameterGroup,
      autoMinorVersionUpgrade: true,
    });
    this.dbCredentialsSecret = this.database.secret!;

    // Composed DATABASE_URL (the app only understands a single URL). The password is pulled through a
    // CloudFormation dynamic reference so the plain value never lands in the template.
    const password = this.dbCredentialsSecret.secretValueFromJson("password").unsafeUnwrap();
    this.databaseUrlSecret = new secretsmanager.Secret(this, "DatabaseUrl", {
      secretName: `mailapp/${config.envName}/DATABASE_URL`,
      description: "Full postgres:// connection string for the mailapp API and worker",
      secretStringValue: SecretValue.unsafePlainText(
        `postgres://${dbUser}:${password}@${this.database.dbInstanceEndpointAddress}:${this.database.dbInstanceEndpointPort}/${dbName}?sslmode=no-verify`,
      ),
      removalPolicy: retain,
    });

    // ---------- Application secrets ----------
    this.jwtSecret = new secretsmanager.Secret(this, "JwtSecret", {
      secretName: `mailapp/${config.envName}/JWT_SECRET`,
      description: "Signing key for dashboard access tokens",
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: retain,
    });
    this.appSecret = new secretsmanager.Secret(this, "AppSecret", {
      secretName: `mailapp/${config.envName}/APP_SECRET`,
      description: "HMAC key for unsubscribe tokens",
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: retain,
    });
    this.externalSecrets = new secretsmanager.Secret(this, "ExternalSecrets", {
      secretName: `mailapp/${config.envName}/external`,
      description: "Third-party credentials: ANTHROPIC_API_KEY, IMAP_PASSWORD. Set real values after deploy.",
      secretObjectValue: {
        ANTHROPIC_API_KEY: SecretValue.unsafePlainText("REPLACE_ME"),
        IMAP_PASSWORD: SecretValue.unsafePlainText(""),
      },
      removalPolicy: retain,
    });

    // ---------- Buckets ----------
    this.storageBucket = new s3.Bucket(this, "StorageBucket", {
      bucketName: undefined, // let CFN generate a unique name
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: retain,
      autoDeleteObjects: !config.isProd,
      lifecycleRules: [
        { id: "expire-old-versions", noncurrentVersionExpiration: Duration.days(90) },
        { id: "abort-multipart", abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    });

    this.inboundBucket = new s3.Bucket(this, "InboundMailBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: retain,
      autoDeleteObjects: !config.isProd,
      lifecycleRules: [{ id: "expire-inbound", expiration: Duration.days(90) }],
    });

    // ---------- Log groups ----------
    const retention = config.isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.TWO_WEEKS;
    this.apiLogGroup = new logs.LogGroup(this, "ApiLogs", {
      logGroupName: `/mailapp/${config.envName}/api`,
      retention,
      removalPolicy: retain,
    });
    this.workerLogGroup = new logs.LogGroup(this, "WorkerLogs", {
      logGroupName: `/mailapp/${config.envName}/worker`,
      retention,
      removalPolicy: retain,
    });
    this.migrateLogGroup = new logs.LogGroup(this, "MigrateLogs", {
      logGroupName: `/mailapp/${config.envName}/migrate`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: retain,
    });

    new CfnOutput(this, "DbEndpoint", { value: this.database.dbInstanceEndpointAddress });
    new CfnOutput(this, "DatabaseUrlSecretArn", { value: this.databaseUrlSecret.secretArn });
    new CfnOutput(this, "ExternalSecretsArn", {
      value: this.externalSecrets.secretArn,
      description: "Put ANTHROPIC_API_KEY / IMAP_PASSWORD here",
    });
    new CfnOutput(this, "StorageBucketName", { value: this.storageBucket.bucketName });
    new CfnOutput(this, "InboundBucketName", { value: this.inboundBucket.bucketName });
  }
}
