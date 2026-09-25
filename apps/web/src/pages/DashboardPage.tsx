import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type {
  OverviewAnalytics,
  SesAccountInfo,
  SesMetricsResponse,
  SystemStatus,
  TimeseriesPoint,
} from "@mailapp/shared";
import { api } from "../lib/api";
import { compactNumber, formatDate, percent } from "../lib/format";
import { StatTile } from "../components/StatTile";
import { SesMetricsChart, TimeseriesChart } from "../components/charts";
import { StatusBadge } from "../components/StatusBadge";
import { Banner, ErrorBox, KeyValue, PageHeader, Spinner } from "../components/ui";

interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  failures: number;
  avgLatencyMs: number;
}

const RANGES = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
];

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
    queryFn: () => api.get<LlmUsage>("/api/analytics/llm-usage", range),
  });
  const system = useQuery({
    queryKey: ["system", "status"],
    queryFn: () => api.get<SystemStatus>("/api/system/status"),
    refetchInterval: 60_000,
  });

  const t = overview.data?.totals;
  const r = overview.data?.rates;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        subtitle="Outreach performance, SES health and system status"
        actions={
          <div className="flex gap-1 rounded-md border border-gray-200 bg-white p-0.5">
            {RANGES.map((x) => (
              <button
                key={x.key}
                onClick={() => setDays(x.key)}
                className={"rounded px-2 py-1 text-xs " + (days === x.key ? "bg-brand-50 font-medium text-brand-700" : "text-gray-600")}
              >
                {x.label}
              </button>
            ))}
          </div>
        }
      />

      {system.data && (system.data.sesMode === "mock" || system.data.llmProvider === "mock") && (
        <Banner kind="warning">
          Running with {system.data.sesMode === "mock" ? "SES in mock mode (no real emails are sent)" : ""}
          {system.data.sesMode === "mock" && system.data.llmProvider === "mock" ? " and " : ""}
          {system.data.llmProvider === "mock" ? "the mock LLM provider (drafts are placeholders)" : ""}. Configure the
          environment before production use.
        </Banner>
      )}

      {overview.isLoading ? (
        <Spinner />
      ) : overview.error ? (
        <ErrorBox message={(overview.error as Error).message} />
      ) : (
        t &&
        r && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <StatTile label="Sent" value={t.sent} />
            <StatTile label="Delivered" value={t.delivered} rate={r.deliveryRate} rateLabel="of sent" />
            <StatTile label="Opened" value={t.opened} rate={r.openRate} rateLabel="open rate" />
            <StatTile label="Clicked" value={t.clicked} rate={r.clickRate} rateLabel="click rate" />
            <StatTile label="Replied" value={t.replied} rate={r.replyRate} rateLabel="reply rate" tone="good" />
            <StatTile label="Bounced" value={t.bounced} rate={r.bounceRate} rateLabel="bounce rate" tone={r.bounceRate > 0.05 ? "critical" : undefined} />
            <StatTile label="Complaints" value={t.complained} rate={r.complaintRate} rateLabel="complaint rate" tone={r.complaintRate > 0.001 ? "critical" : undefined} />
            <StatTile label="Pending review" value={t.pendingReview} tone={t.pendingReview > 0 ? "warning" : undefined} />
          </div>
        )
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="card xl:col-span-2">
          <h2 className="mb-2 text-sm font-semibold">Activity over time</h2>
          {series.isLoading ? <Spinner /> : series.error ? <ErrorBox message={(series.error as Error).message} /> : <TimeseriesChart points={series.data?.points ?? []} />}
        </div>
        <div className="card">
          <h2 className="mb-2 text-sm font-semibold">SES account</h2>
          {ses.isLoading ? (
            <Spinner />
          ) : ses.error ? (
            <ErrorBox message={(ses.error as Error).message} />
          ) : ses.data ? (
            <div className="space-y-2">
              {ses.data.error && <Banner kind="danger">{ses.data.error}</Banner>}
              <KeyValue
                items={[
                  ["Mode", ses.data.mode === "mock" ? "mock (dry run)" : "live"],
                  ["Region", ses.data.region],
                  ["Sending enabled", ses.data.sendingEnabled ? "yes" : "no"],
                  ["Production access", ses.data.productionAccessEnabled ? "yes" : "sandbox"],
                  ["Enforcement status", ses.data.enforcementStatus ?? "—"],
                  ["24h quota", ses.data.sendQuota ? compactNumber(ses.data.sendQuota.max24HourSend) : "—"],
                  ["Sent last 24h", ses.data.sendQuota ? compactNumber(ses.data.sendQuota.sentLast24Hours) : "—"],
                  ["Max send rate", ses.data.sendQuota ? `${ses.data.sendQuota.maxSendRate}/s` : "—"],
                  ["VDM", ses.data.vdmEnabled === null ? "—" : ses.data.vdmEnabled ? "enabled" : "disabled"],
                  ["Fetched", formatDate(ses.data.fetchedAt)],
                ]}
              />
              {ses.data.sendQuota && ses.data.sendQuota.max24HourSend > 0 && (
                <div>
                  <div className="mb-1 flex justify-between text-xs text-gray-500">
                    <span>Quota used</span>
                    <span>{percent(ses.data.sendQuota.sentLast24Hours / ses.data.sendQuota.max24HourSend)}</span>
                  </div>
                  <div className="h-2 w-full rounded bg-brand-100">
                    <div
                      className="h-2 rounded bg-brand-500"
                      style={{ width: `${Math.min(100, (100 * ses.data.sendQuota.sentLast24Hours) / ses.data.sendQuota.max24HourSend)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="card xl:col-span-2">
          <h2 className="mb-2 text-sm font-semibold">SES metrics (CloudWatch, last 24h)</h2>
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
        </div>
        <div className="space-y-4">
          <div className="card">
            <h2 className="mb-2 text-sm font-semibold">LLM usage</h2>
            {llm.isLoading ? (
              <Spinner />
            ) : llm.data ? (
              <KeyValue
                items={[
                  ["Calls", compactNumber(llm.data.calls)],
                  ["Failures", compactNumber(llm.data.failures)],
                  ["Input tokens", compactNumber(llm.data.inputTokens)],
                  ["Cache reads", compactNumber(llm.data.cacheReadTokens)],
                  ["Output tokens", compactNumber(llm.data.outputTokens)],
                  ["Avg latency", `${Math.round(llm.data.avgLatencyMs)} ms`],
                ]}
              />
            ) : (
              <ErrorBox message="Unavailable" />
            )}
          </div>
          <div className="card">
            <h2 className="mb-2 text-sm font-semibold">System</h2>
            {system.data ? (
              <div className="space-y-2 text-sm">
                <KeyValue
                  items={[
                    ["DB", system.data.db],
                    ["Queue", system.data.queue],
                    ["Sent today", `${system.data.sentToday} / ${system.data.dailyCap}`],
                    ["Last SES sync", formatDate(system.data.lastSesSyncAt)],
                  ]}
                />
                <table className="table text-xs">
                  <thead>
                    <tr>
                      <th>Queue</th>
                      <th>Active</th>
                      <th>Waiting</th>
                      <th>Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {system.data.queues.map((q) => (
                      <tr key={q.queue}>
                        <td>{q.queue}</td>
                        <td>{q.active}</td>
                        <td>{q.created + q.retry}</td>
                        <td className={q.failed ? "text-red-700" : ""}>{q.failed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Link to="/system" className="text-xs text-brand-700 hover:underline">
                  View system page →
                </Link>
              </div>
            ) : (
              <Spinner />
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="mb-2 text-sm font-semibold">By campaign</h2>
        {overview.data && overview.data.byCampaign.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th className="text-right">Sent</th>
                <th className="text-right">Delivered</th>
                <th className="text-right">Opened</th>
                <th className="text-right">Replied</th>
                <th className="text-right">Bounced</th>
              </tr>
            </thead>
            <tbody>
              {overview.data.byCampaign.map((c) => (
                <tr key={c.campaignId}>
                  <td>
                    <Link to={`/campaigns/${c.campaignId}`} className="text-brand-700 hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="text-right tabular-nums">{c.sent}</td>
                  <td className="text-right tabular-nums">{c.delivered}</td>
                  <td className="text-right tabular-nums">{c.opened}</td>
                  <td className="text-right tabular-nums">{c.replied}</td>
                  <td className="text-right tabular-nums">{c.bounced}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-gray-500">No campaigns in this range.</p>
        )}
      </div>
    </div>
  );
}
