import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatTokens, formatUsd } from "@mailapp/shared";
import type {
  CampaignDto,
  EmailDto,
  LlmUsageDto,
  OverviewAnalytics,
  SesAccountInfo,
  SesMetricsResponse,
  SystemStatus,
  TimeseriesPoint,
} from "@mailapp/shared";
import { ClipboardCheck, Reply, Send, Users, Rocket } from "lucide-react";
import { api } from "../lib/api";
import { compactNumber } from "../lib/format";
import { StatTile } from "../components/StatTile";
import { SesMetricsChart, TimeseriesChart } from "../components/charts";
import { CostByModelTable, CostTile } from "../components/CostPanel";
import {
  ACTION_ICONS,
  ActionCenter,
  CampaignOverview,
  HealthCard,
  PipelineCard,
  SecondaryMetrics,
  Section,
  sumCounts,
  type ActionItem,
} from "../components/dashboard";
import { Banner, ErrorBox, KeyValue, PageHeader, Spinner, StatusDot } from "../components/ui";

const RANGES = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
];

const PERFORMANCE_KEYS = ["sent", "delivered", "opened", "replied"] as const;

function rangeQuery(days: string) {
  const to = new Date();
  const from = new Date(to.getTime() - Number(days) * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function DashboardPage() {
  const [days, setDays] = useState("30");
  const range = rangeQuery(days);
  const overview = useQuery({
    queryKey: ["analytics", "overview", days],
    queryFn: () => api.get<OverviewAnalytics>("/api/analytics/overview", range),
  });
  const series = useQuery({
    queryKey: ["analytics", "timeseries", days],
    queryFn: () => api.get<{ points: TimeseriesPoint[] }>("/api/analytics/timeseries", range),
  });
  const ses = useQuery({
    queryKey: ["analytics", "ses-account"],
    queryFn: () => api.get<SesAccountInfo>("/api/analytics/ses-account"),
    refetchInterval: 120_000,
  });
  const sesMetrics = useQuery({
    queryKey: ["analytics", "ses-metrics"],
    queryFn: () => api.get<SesMetricsResponse>("/api/analytics/ses-metrics", { hours: 24 }),
    refetchInterval: 300_000,
  });
  const llm = useQuery({
    queryKey: ["analytics", "llm", days],
    queryFn: () => api.get<LlmUsageDto>("/api/analytics/llm-usage", range),
  });
  const system = useQuery({
    queryKey: ["system", "status"],
    queryFn: () => api.get<SystemStatus>("/api/system/status"),
    refetchInterval: 60_000,
  });
  const campaigns = useQuery({
    queryKey: ["campaigns", "all"],
    queryFn: () => api.get<{ items: CampaignDto[] }>("/api/campaigns"),
    refetchInterval: 60_000,
  });
  // Drafts waiting on a reviewer: used to count validation failures (the API returns each draft's validation result).
  const reviewDrafts = useQuery({
    queryKey: ["emails", "pending_review", "dashboard"],
    queryFn: () => api.get<{ items: EmailDto[]; total: number }>("/api/emails", { status: "pending_review", pageSize: 200 }),
    refetchInterval: 60_000,
  });
  const failedSends = useQuery({
    queryKey: ["emails", "failed", "dashboard"],
    queryFn: () => api.get<{ items: EmailDto[]; total: number }>("/api/emails", { status: "failed", pageSize: 1 }),
    refetchInterval: 60_000,
  });

  const t = overview.data?.totals;
  const r = overview.data?.rates;

  // Pipeline, active campaigns and the lead counts come from the campaign list (all-time, archived excluded).
  const live = useMemo(() => (campaigns.data?.items ?? []).filter((c) => c.status !== "archived"), [campaigns.data]);
  const counts = useMemo(() => sumCounts(live.map((c) => c.counts)), [live]);
  const activeCampaigns = live.filter((c) => c.status === "active").length;
  const leadsProcessed = Math.max(0, counts.total - counts.pending);

  const validationFailures = (reviewDrafts.data?.items ?? []).filter((e) => e.validation && !e.validation.ok).length;
  const repliedCampaigns = live.filter((c) => c.counts.replied > 0).length;

  const actions: ActionItem[] = [
    {
      key: "review",
      icon: ACTION_ICONS.review,
      tone: "warning",
      title: "Drafts pending review",
      detail: "Approve, edit or reject in the review queue",
      count: reviewDrafts.data?.total ?? counts.pendingReview,
      to: "/review",
    },
    {
      key: "validation",
      icon: ACTION_ICONS.validation,
      tone: "warning",
      title: "Drafts that failed validation",
      detail: "Broke a hard rule, fix or regenerate before approving",
      count: validationFailures,
      to: "/review",
    },
    {
      key: "failedLeads",
      icon: ACTION_ICONS.failedLeads,
      tone: "critical",
      title: "Leads with failed jobs",
      detail: "Research or drafting failed, retry from the campaign",
      count: counts.failed,
      to: "/campaigns",
    },
    {
      key: "failedSends",
      icon: ACTION_ICONS.failedSends,
      tone: "critical",
      title: "Emails that failed to send",
      detail: "Open the campaign to see the error and retry",
      count: failedSends.data?.total ?? 0,
      to: "/campaigns",
    },
    {
      key: "replies",
      icon: ACTION_ICONS.replies,
      tone: "info",
      title: "Replies received",
      detail: `Across ${repliedCampaigns} campaign${repliedCampaigns === 1 ? "" : "s"}, follow-ups stopped`,
      count: counts.replied,
      to: "/campaigns",
    },
  ];

  const isMock = system.data && (system.data.sesMode === "mock" || system.data.llmProvider === "mock");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Outreach operations at a glance"
        actions={
          <div role="group" aria-label="Date range" className="inline-flex rounded-lg border border-gray-200 bg-gray-100/70 p-0.5">
            {RANGES.map((x) => (
              <button
                key={x.key}
                onClick={() => setDays(x.key)}
                aria-pressed={days === x.key}
                className={
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors " +
                  (days === x.key ? "bg-white text-gray-900 shadow-card" : "text-gray-500 hover:text-gray-800")
                }
              >
                {x.label}
              </button>
            ))}
          </div>
        }
      />

      {isMock && system.data && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <StatusDot tone="warning" />
          <span className="font-medium text-gray-700">Mock mode</span>
          <span>
            {system.data.sesMode === "mock" ? "SES dry run, no real emails are sent" : ""}
            {system.data.sesMode === "mock" && system.data.llmProvider === "mock" ? " · " : ""}
            {system.data.llmProvider === "mock" ? "placeholder drafts" : ""}
          </span>
        </div>
      )}

      {/* Overview: five headline numbers, then the quieter delivery metrics as one strip. */}
      {overview.isLoading || campaigns.isLoading ? (
        <Spinner />
      ) : overview.error ? (
        <ErrorBox message={(overview.error as Error).message} />
      ) : (
        t &&
        r && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
              <StatTile primary icon={Rocket} label="Active campaigns" value={activeCampaigns} hint={`${live.length} in total`} />
              <StatTile primary icon={Users} label="Leads processed" value={leadsProcessed} hint={`of ${compactNumber(counts.total)} imported`} />
              <StatTile
                primary
                icon={ClipboardCheck}
                label="Pending review"
                value={t.pendingReview}
                tone={t.pendingReview > 0 ? "warning" : undefined}
                hint={t.pendingReview > 0 ? "Waiting for a reviewer" : "Nothing waiting"}
              />
              <StatTile primary icon={Send} label="Emails sent" value={t.sent} hint={`last ${days} days`} />
              <StatTile primary icon={Reply} label="Replies received" value={t.replied} rate={r.replyRate} rateLabel="reply rate" tone={t.replied > 0 ? "good" : undefined} />
            </div>
            <SecondaryMetrics
              items={[
                { label: "Delivered", value: t.delivered, rate: r.deliveryRate, rateLabel: "of sent" },
                { label: "Opened", value: t.opened, rate: r.openRate, rateLabel: "open rate" },
                { label: "Clicked", value: t.clicked, rate: r.clickRate, rateLabel: "click rate" },
                { label: "Bounced", value: t.bounced, rate: r.bounceRate, rateLabel: "bounce rate", tone: r.bounceRate > 0.05 ? "critical" : undefined },
                { label: "Complaints", value: t.complained, rate: r.complaintRate, rateLabel: "rate", tone: r.complaintRate > 0.001 ? "critical" : undefined },
              ]}
            />
          </div>
        )
      )}

      <PipelineCard counts={counts} />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <Section
          className="xl:col-span-2"
          title="Campaign performance"
          subtitle={`Sent, delivered, opened and replied · last ${days} days`}
        >
          {series.isLoading ? (
            <Spinner />
          ) : series.error ? (
            <ErrorBox message={(series.error as Error).message} />
          ) : (
            <TimeseriesChart points={series.data?.points ?? []} keys={[...PERFORMANCE_KEYS]} />
          )}
        </Section>
        <ActionCenter items={actions} loading={campaigns.isLoading} />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <CampaignOverview campaigns={live} />
        <HealthCard system={system.data} ses={ses.data} />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <Section className="xl:col-span-2" title="SES delivery metrics" subtitle="CloudWatch, last 24 hours">
          {sesMetrics.isLoading ? (
            <Spinner />
          ) : sesMetrics.error ? (
            <ErrorBox message={(sesMetrics.error as Error).message} />
          ) : sesMetrics.data && !sesMetrics.data.enabled ? (
            <p className="text-sm text-gray-500">
              CloudWatch SES metrics are disabled. Set <code>CLOUDWATCH_SES_METRICS_ENABLED=true</code> and grant{" "}
              <code>cloudwatch:GetMetricData</code> to pull Send / Delivery / Bounce / Complaint / Open / Click series here.
            </p>
          ) : sesMetrics.data?.error ? (
            <Banner kind="danger">{sesMetrics.data.error}</Banner>
          ) : (
            <SesMetricsChart series={sesMetrics.data?.series ?? []} />
          )}
        </Section>

        <Section title="Model spend" subtitle={`Last ${days} days`}>
          {llm.isLoading ? (
            <Spinner />
          ) : llm.data ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                <CostTile label="Total" value={formatUsd(llm.data.totalMicroUsd)} hint={`${compactNumber(llm.data.calls)} calls`} />
                <CostTile label="Per email" value={formatUsd(llm.data.microUsdPerSentEmail)} hint="sent" />
                <CostTile label="Per lead" value={formatUsd(llm.data.microUsdPerLead)} hint="research + drafts" />
              </div>
              <KeyValue
                items={[
                  ["Input tokens", formatTokens(llm.data.inputTokens)],
                  ["Cache reads", formatTokens(llm.data.cacheReadTokens)],
                  ["Output tokens", formatTokens(llm.data.outputTokens)],
                  ["Failures", compactNumber(llm.data.failures)],
                  ["Avg latency", `${Math.round(llm.data.avgLatencyMs)} ms`],
                ]}
              />
              <details className="rounded-lg border border-gray-200">
                <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-gray-600">By model</summary>
                <div className="px-3 pb-2">
                  <CostByModelTable rows={llm.data.byModel} />
                </div>
              </details>
            </div>
          ) : (
            <ErrorBox message="Unavailable" />
          )}
        </Section>
      </div>
    </div>
  );
}
