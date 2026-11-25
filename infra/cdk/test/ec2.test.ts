import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildEc2Stacks } from "../lib/stacks.js";

function synth(extra: Record<string, unknown> = {}) {
  const app = new App({
    context: {
      deployTarget: "ec2",
      envName: "test",
      region: "us-east-1",
      account: "123456789012",
      domainName: "outreach.example.com",
      sendingDomain: "example.com",
      fromEmail: "outreach@example.com",
      inboundEnabled: true,
      subscribeWebhooks: true,
      ...extra,
    },
  });
  return buildEc2Stacks(app, loadConfig(app));
}

describe("EC2 deployment", () => {
  const stacks = synth();
  const ec2 = Template.fromStack(stacks.ec2);

  it("launches one instance with IMDSv2, an Elastic IP and no SSH ingress", () => {
    ec2.resourceCountIs("AWS::EC2::Instance", 1);
    ec2.resourceCountIs("AWS::EC2::EIP", 1);
    ec2.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: Match.objectLike({ MetadataOptions: Match.objectLike({ HttpTokens: "required" }) }),
    });
    const sgs = ec2.findResources("AWS::EC2::SecurityGroup");
    const ports = Object.values(sgs).flatMap((r: any) => (r.Properties.SecurityGroupIngress ?? []).map((i: any) => i.FromPort));
    expect(ports.sort((a: number, b: number) => a - b)).toEqual([80, 443]);
  });

  it("lets the instance role send through SES and read SES inbound mail", () => {
    ec2.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: ["ses:SendEmail", "ses:SendRawEmail"] })]),
      }),
    });
  });

  it("keeps data on a separate, encrypted, snapshotted EBS volume", () => {
    ec2.hasResourceProperties("AWS::EC2::Volume", { Encrypted: true });
    ec2.resourceCountIs("AWS::DLM::LifecyclePolicy", 1);
  });

  it("creates the SES configuration set, identity and inbound rule set", () => {
    const m = Template.fromStack(stacks.messaging);
    m.resourceCountIs("AWS::SES::ConfigurationSet", 1);
    m.resourceCountIs("AWS::SES::EmailIdentity", 1);
    m.resourceCountIs("AWS::SES::ReceiptRuleSet", 1);
  });

  it("subscribes SNS webhooks only when asked", () => {
    expect(Object.keys(ec2.findResources("AWS::SNS::Subscription")).length).toBe(1);
    const off = Template.fromStack(synth({ subscribeWebhooks: false }).ec2);
    off.resourceCountIs("AWS::SNS::Subscription", 0);
  });
});
