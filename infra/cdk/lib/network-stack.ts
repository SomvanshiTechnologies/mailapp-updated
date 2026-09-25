import { Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import type { MailAppConfig } from "../config.js";

export interface NetworkStackProps extends StackProps {
  config: MailAppConfig;
}

/**
 * Minimal VPC for an internal deployment: no NAT gateway. The ALB and the ECS tasks (with public IPs)
 * live in public subnets; RDS lives in isolated subnets reachable only from the task security group.
 * AWS still requires two AZs for an ALB and for an RDS subnet group, but nothing here is redundant.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly albSecurityGroup: ec2.SecurityGroup;
  readonly appSecurityGroup: ec2.SecurityGroup;
  readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `mailapp-${props.config.envName}`,
      maxAzs: 2,
      natGateways: 0,
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/16"),
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Keep S3 traffic (uploads/exports/inbound mail) inside the AWS network.
    this.vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });

    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSg", {
      vpc: this.vpc,
      description: "mailapp ALB",
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP (redirects to HTTPS)");
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    this.appSecurityGroup = new ec2.SecurityGroup(this, "AppSg", {
      vpc: this.vpc,
      description: "mailapp ECS tasks (api + worker)",
      allowAllOutbound: true,
    });
    this.appSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(4000), "ALB to API");

    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc: this.vpc,
      description: "mailapp RDS PostgreSQL",
      allowAllOutbound: false,
    });
    this.dbSecurityGroup.addIngressRule(this.appSecurityGroup, ec2.Port.tcp(5432), "ECS tasks to Postgres");
  }
}
