import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { MailAppConfig } from "../config.js";

export interface StorageStackProps extends StackProps {
  config: MailAppConfig;
}

/** EC2 target only: the S3 bucket SES stores inbound (reply) mail in. Everything else lives on the instance. */
export class StorageStack extends Stack {
  readonly inboundBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const retain = props.config.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    this.inboundBucket = new s3.Bucket(this, "InboundMailBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: retain,
      autoDeleteObjects: !props.config.isProd,
      lifecycleRules: [{ id: "expire-inbound", expiration: Duration.days(90) }],
    });
    new CfnOutput(this, "InboundBucketName", { value: this.inboundBucket.bucketName });
  }
}
