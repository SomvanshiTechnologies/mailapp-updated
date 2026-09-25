import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { MailAppConfig } from "../config.js";
import type { ComputeStack } from "./compute-stack.js";
import type { DataStack } from "./data-stack.js";
import type { MessagingStack } from "./messaging-stack.js";

export interface ObservabilityStackProps extends StackProps {
  config: MailAppConfig;
  data: DataStack;
  messaging: MessagingStack;
  compute: ComputeStack;
}

/** CloudWatch dashboard + alarms wired to an alerts SNS topic. */
export class ObservabilityStack extends Stack {
  readonly alertsTopic: sns.Topic;
  readonly dashboard: cloudwatch.Dashboard;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { config, data, messaging, compute } = props;

    this.alertsTopic = new sns.Topic(this, "AlertsTopic", {
      topicName: `mailapp-${config.envName}-alerts`,
      displayName: "mailapp alarms",
    });
    if (config.alertEmail) {
      this.alertsTopic.addSubscription(new snsSubscriptions.EmailSubscription(config.alertEmail));
    }
    const alarmAction = new cwActions.SnsAction(this.alertsTopic);
    const addAlarm = (alarm: cloudwatch.Alarm) => {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
      this.alarms.push(alarm);
      return alarm;
    };

    // ---------- SES metrics ----------
    const sesDims = { "ses:configuration-set": messaging.configurationSetName };
    const sesMetric = (metricName: string, statistic = "Sum", period = Duration.minutes(5)) =>
      new cloudwatch.Metric({ namespace: "AWS/SES", metricName, dimensionsMap: sesDims, statistic, period });
    const sesCount = (name: string) => sesMetric(name);
    const bounceRate = sesMetric("Reputation.BounceRate", "Average", Duration.hours(1));
    const complaintRate = sesMetric("Reputation.ComplaintRate", "Average", Duration.hours(1));

    // ---------- App metrics ----------
    const appMetric = (metricName: string, statistic = "Sum") =>
      new cloudwatch.Metric({
        namespace: "MailApp",
        metricName,
        dimensionsMap: { Service: "worker" },
        statistic,
        period: Duration.minutes(5),
      });

    // ---------- Infra metrics ----------
    const api = compute.apiService;
    const alb = compute.loadBalancer;
    const rds = data.database;
    const ecsMetric = (serviceName: string, metricName: string, statistic = "Average") =>
      new cloudwatch.Metric({
        namespace: "AWS/ECS",
        metricName,
        dimensionsMap: { ClusterName: compute.cluster.clusterName, ServiceName: serviceName },
        statistic,
        period: Duration.minutes(5),
      });
    const workerRunning = new cloudwatch.Metric({
      namespace: "ECS/ContainerInsights",
      metricName: "RunningTaskCount",
      dimensionsMap: { ClusterName: compute.cluster.clusterName, ServiceName: compute.workerService.serviceName },
      statistic: "Minimum",
      period: Duration.minutes(1),
    });

    // ---------- Alarms ----------
    addAlarm(
      new cloudwatch.Alarm(this, "SesBounceRateAlarm", {
        alarmName: `mailapp-${config.envName}-ses-bounce-rate`,
        alarmDescription: "SES bounce rate above 5% (AWS reviews accounts at 5%, pauses at 10%)",
        metric: bounceRate,
        threshold: 0.05,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, "SesComplaintRateAlarm", {
        alarmName: `mailapp-${config.envName}-ses-complaint-rate`,
        alarmDescription: "SES complaint rate above 0.1% (AWS reviews at 0.1%, pauses at 0.5%)",
        metric: complaintRate,
        threshold: 0.001,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, "Alb5xxAlarm", {
        alarmName: `mailapp-${config.envName}-alb-5xx`,
        alarmDescription: "More than 10 5xx responses from the API in 5 minutes",
        metric: alb.metrics.httpCodeTarget(elbHttpCode5xx(), { period: Duration.minutes(5), statistic: "Sum" }),
        threshold: 10,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, "AlbUnhealthyHostsAlarm", {
        alarmName: `mailapp-${config.envName}-alb-unhealthy-hosts`,
        alarmDescription: "At least one API task is failing its health check",
        metric: api.targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1), statistic: "Maximum" }),
        threshold: 0,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, "WorkerDownAlarm", {
        alarmName: `mailapp-${config.envName}-worker-down`,
        alarmDescription: "No worker task running: research/drafting/sending/follow-ups are stalled",
        metric: workerRunning,
        threshold: 1,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, "SendFailuresAlarm", {
        alarmName: `mailapp-${config.envName}-send-failures`,
        alarmDescription: "More than 5 SES send failures in 5 minutes",
        metric: appMetric("send_failures"),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, "LlmFailuresAlarm", {
        alarmName: `mailapp-${config.envName}-llm-failures`,
        alarmDescription: "More than 5 LLM call failures in 5 minutes",
        metric: appMetric("llm_failures"),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, "RdsFreeStorageAlarm", {
        alarmName: `mailapp-${config.envName}-rds-free-storage`,
        alarmDescription: "RDS free storage below 2 GiB",
        metric: rds.metricFreeStorageSpace({ period: Duration.minutes(5), statistic: "Minimum" }),
        threshold: 2 * 1024 * 1024 * 1024,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, "RdsCpuAlarm", {
        alarmName: `mailapp-${config.envName}-rds-cpu`,
        alarmDescription: "RDS CPU above 85% for 15 minutes",
        metric: rds.metricCPUUtilization({ period: Duration.minutes(5) }),
        threshold: 85,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // ---------- Dashboard ----------
    this.dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `mailapp-${config.envName}`,
      defaultInterval: Duration.hours(24),
    });
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# Outreach Engine – ${config.envName}\nSES configuration set **${messaging.configurationSetName}** · cluster **${compute.cluster.clusterName}**`,
        width: 24,
        height: 2,
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "SES sends & deliveries",
        width: 8,
        left: [sesCount("Send"), sesCount("Delivery"), sesCount("Reject"), sesCount("RenderingFailure")],
      }),
      new cloudwatch.GraphWidget({
        title: "SES bounces & complaints",
        width: 8,
        left: [sesCount("Bounce"), sesCount("Complaint"), sesCount("DeliveryDelay")],
      }),
      new cloudwatch.GraphWidget({
        title: "SES engagement",
        width: 8,
        left: [sesCount("Open"), sesCount("Click")],
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "SES reputation (account-level rates)",
        width: 12,
        left: [bounceRate, complaintRate],
        leftAnnotations: [
          { value: 0.05, label: "bounce 5%", color: "#d62728" },
          { value: 0.001, label: "complaint 0.1%", color: "#ff7f0e" },
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "App: sends / failures / rate-limited",
        width: 12,
        left: [appMetric("emails_sent"), appMetric("send_failures"), appMetric("send_rate_limited")],
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "App: pipeline",
        width: 12,
        left: [
          appMetric("research_completed"),
          appMetric("research_failures"),
          appMetric("drafts_created"),
          appMetric("drafts_rejected_by_validator"),
          appMetric("followups_scheduled"),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "App: LLM",
        width: 12,
        left: [appMetric("llm_calls"), appMetric("llm_failures")],
        right: [appMetric("llm_latency_ms", "Average")],
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "App: engagement events",
        width: 12,
        left: [appMetric("events_ingested"), appMetric("bounces"), appMetric("complaints"), appMetric("replies"), appMetric("unsubscribes")],
      }),
      new cloudwatch.GraphWidget({
        title: "ALB requests / 5xx / latency",
        width: 12,
        left: [
          alb.metrics.requestCount({ period: Duration.minutes(5) }),
          alb.metrics.httpCodeTarget(elbHttpCode5xx(), { period: Duration.minutes(5), statistic: "Sum" }),
          alb.metrics.httpCodeElb(elbCode5xx(), { period: Duration.minutes(5), statistic: "Sum" }),
        ],
        right: [alb.metrics.targetResponseTime({ period: Duration.minutes(5), statistic: "p95" })],
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "ECS CPU / memory (api)",
        width: 8,
        left: [ecsMetric(api.service.serviceName, "CPUUtilization"), ecsMetric(api.service.serviceName, "MemoryUtilization")],
      }),
      new cloudwatch.GraphWidget({
        title: "ECS CPU / memory (worker)",
        width: 8,
        left: [
          ecsMetric(compute.workerService.serviceName, "CPUUtilization"),
          ecsMetric(compute.workerService.serviceName, "MemoryUtilization"),
        ],
        right: [workerRunning],
      }),
      new cloudwatch.GraphWidget({
        title: "RDS CPU / connections / free storage",
        width: 8,
        left: [rds.metricCPUUtilization(), rds.metricDatabaseConnections()],
        right: [rds.metricFreeStorageSpace()],
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({ title: "Alarms", width: 24, height: 3, alarms: this.alarms }),
    );

    new CfnOutput(this, "AlertsTopicArn", { value: this.alertsTopic.topicArn });
    new CfnOutput(this, "DashboardName", { value: this.dashboard.dashboardName });
  }
}

// Small helpers so the enum imports stay in one place.
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
function elbHttpCode5xx(): elbv2.HttpCodeTarget {
  return elbv2.HttpCodeTarget.TARGET_5XX_COUNT;
}
function elbCode5xx(): elbv2.HttpCodeElb {
  return elbv2.HttpCodeElb.ELB_5XX_COUNT;
}
