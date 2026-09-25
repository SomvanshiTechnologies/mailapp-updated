import { Annotations, CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sesActions from "aws-cdk-lib/aws-ses-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import type { MailAppConfig } from "../config.js";
import type { DataStack } from "./data-stack.js";

export interface MessagingStackProps extends StackProps {
  config: MailAppConfig;
  data: DataStack;
}

/** All SES event types the application ingests. Keep in sync with SES_EVENT_TYPES in packages/shared. */
export const SES_EVENTS: ses.EmailSendingEvent[] = [
  ses.EmailSendingEvent.SEND,
  ses.EmailSendingEvent.DELIVERY,
  ses.EmailSendingEvent.BOUNCE,
  ses.EmailSendingEvent.COMPLAINT,
  ses.EmailSendingEvent.REJECT,
  ses.EmailSendingEvent.OPEN,
  ses.EmailSendingEvent.CLICK,
  ses.EmailSendingEvent.RENDERING_FAILURE,
  ses.EmailSendingEvent.DELIVERY_DELAY,
  ses.EmailSendingEvent.SUBSCRIPTION,
];

/** SES configuration set + event destination, sending identity, optional inbound receipt rules. */
export class MessagingStack extends Stack {
  readonly configurationSet: ses.ConfigurationSet;
  readonly configurationSetName: string;
  readonly eventsTopic: sns.Topic;
  readonly inboundTopic?: sns.Topic;
  readonly receiptRuleSet?: ses.ReceiptRuleSet;
  readonly inboundPrefix = "inbound/";
  readonly identity?: ses.EmailIdentity;

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props);
    const { config, data } = props;

    this.eventsTopic = new sns.Topic(this, "SesEventsTopic", {
      topicName: `mailapp-${config.envName}-ses-events`,
      displayName: "mailapp SES sending events",
    });

    this.configurationSetName = `mailapp-${config.envName}-events`;
    this.configurationSet = new ses.ConfigurationSet(this, "ConfigurationSet", {
      configurationSetName: this.configurationSetName,
      reputationMetrics: true,
      sendingEnabled: true,
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    this.configurationSet.addEventDestination("SnsEvents", {
      configurationSetEventDestinationName: "sns-all-events",
      destination: ses.EventDestination.snsTopic(this.eventsTopic),
      events: SES_EVENTS,
      enabled: true,
    });

    // ---------- Sending identity ----------
    if (config.sendingDomain) {
      const zone = config.hostedZoneId
        ? route53.HostedZone.fromHostedZoneAttributes(this, "SendingZone", {
            hostedZoneId: config.hostedZoneId,
            zoneName: config.sendingDomain,
          })
        : undefined;
      this.identity = new ses.EmailIdentity(this, "SendingIdentity", {
        identity: zone ? ses.Identity.publicHostedZone(zone) : ses.Identity.domain(config.sendingDomain),
        dkimSigning: true,
        configurationSet: this.configurationSet,
        mailFromDomain: `mail.${config.sendingDomain}`,
      });
      this.identity.dkimRecords.forEach((rec, i) => {
        new CfnOutput(this, `DkimCname${i + 1}Name`, { value: rec.name, description: "DKIM CNAME record name" });
        new CfnOutput(this, `DkimCname${i + 1}Value`, { value: rec.value, description: "DKIM CNAME record value" });
      });
      new CfnOutput(this, "MailFromMxRecord", {
        value: `mail.${config.sendingDomain} MX 10 feedback-smtp.${this.region}.amazonses.com`,
        description: "Custom MAIL FROM MX record to create (plus TXT 'v=spf1 include:amazonses.com ~all')",
      });
    } else {
      Annotations.of(this).addWarning(
        'No "sendingDomain" context: the SES identity is not managed by CDK. Verify your domain/email in the SES console.',
      );
    }

    // ---------- Inbound (replies) ----------
    if (config.inboundEnabled) {
      const inboundDomain = config.inboundDomain || config.sendingDomain;
      this.inboundTopic = new sns.Topic(this, "SesInboundTopic", {
        topicName: `mailapp-${config.envName}-ses-inbound`,
        displayName: "mailapp inbound mail notifications",
      });
      this.receiptRuleSet = new ses.ReceiptRuleSet(this, "InboundRuleSet", {
        receiptRuleSetName: `mailapp-${config.envName}-inbound`,
        dropSpam: true,
        rules: [
          {
            receiptRuleName: "store-to-s3",
            recipients: [inboundDomain],
            enabled: true,
            scanEnabled: true,
            tlsPolicy: ses.TlsPolicy.OPTIONAL,
            actions: [
              new sesActions.S3({
                bucket: data.inboundBucket,
                objectKeyPrefix: this.inboundPrefix,
                topic: this.inboundTopic,
              }),
            ],
          },
        ],
      });
      // SES only receives mail for the one *active* rule set in the region; CloudFormation has no
      // resource for activation, so an SDK call does it (and deactivates on stack deletion).
      const activate = new cr.AwsCustomResource(this, "ActivateInboundRuleSet", {
        onCreate: {
          service: "SES",
          action: "setActiveReceiptRuleSet",
          parameters: { RuleSetName: this.receiptRuleSet.receiptRuleSetName },
          physicalResourceId: cr.PhysicalResourceId.of(`active-rule-set-${config.envName}`),
        },
        onUpdate: {
          service: "SES",
          action: "setActiveReceiptRuleSet",
          parameters: { RuleSetName: this.receiptRuleSet.receiptRuleSetName },
          physicalResourceId: cr.PhysicalResourceId.of(`active-rule-set-${config.envName}`),
        },
        onDelete: { service: "SES", action: "setActiveReceiptRuleSet", parameters: {} },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
        installLatestAwsSdk: false,
      });
      activate.node.addDependency(this.receiptRuleSet);
      new CfnOutput(this, "InboundRuleSetName", {
        value: this.receiptRuleSet.receiptRuleSetName,
        description: "Activated automatically by the ActivateInboundRuleSet custom resource",
      });
      new CfnOutput(this, "InboundMxRecord", {
        value: `${inboundDomain} MX 10 inbound-smtp.${this.region}.amazonaws.com`,
        description: "DNS record to add so SES receives replies for the inbound domain",
      });
      new CfnOutput(this, "InboundTopicArn", { value: this.inboundTopic.topicArn });
    }

    new CfnOutput(this, "ConfigurationSetName", { value: this.configurationSetName });
    new CfnOutput(this, "EventsTopicArn", { value: this.eventsTopic.topicArn });
  }
}
