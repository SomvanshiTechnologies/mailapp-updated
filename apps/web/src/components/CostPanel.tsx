import { useQuery } from "@tanstack/react-query";
import {
  BATCH_STRATEGY_LABELS,
  PROVIDER_LABELS,
  formatTokens,
  formatUsd,
  type BatchDto,
  type CampaignCostDto,
  type CostByModel,
  type CostEstimate,
  type CostSummary,
  type ResolvedAiConfig,
} from "@mailapp/shared";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { BatchTag } from "./ModelSelect";
import { Banner, ErrorBox, Spinner } from "./ui";

/** A single money/token figure with a caption. */
export function CostTile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "warning" }) {
  const valueCls = tone === "warning" ? "text-amber-700" : tone === "good" ? "text-emerald-700" : "text-gray-900";
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={"mt-0.5 text-lg font-semibold tabular-nums " + valueCls}>{value}</div>
      {hint && <div className="text-[11px] text-gray-400">{hint}</div>}
    </div>
  );
}

/** The four numbers that matter: total, per lead, per email, tokens. */
export function CostSummaryTiles({ cost, compact }: { cost: CostSummary; compact?: boolean }) {
  const tokens = cost.inputTokens + cost.cachedInputTokens + cost.outputTokens;
  return (
    <div className={"grid gap-2 " + (compact ? "grid-cols-2 md:grid-cols-4" : "grid-cols-2 md:grid-cols-5")}>
      <CostTile label="Spent so far" value={formatUsd(cost.totalMicroUsd)} hint={`${cost.calls} model call${cost.calls === 1 ? "" : "s"}`} />
      <CostTile label="Per lead" value={formatUsd(cost.perLeadMicroUsd)} hint={`${cost.leads} lead${cost.leads === 1 ? "" : "s"}`} />
      <CostTile label="Per email" value={formatUsd(cost.perEmailMicroUsd)} hint={`${cost.emails} drafted`} />
      <CostTile label="Tokens" value={formatTokens(tokens)} hint={`${formatTokens(cost.cachedInputTokens)} cached`} />
      {!compact && (
        <CostTile
          label="Via batch"
          value={`${cost.batchSharePct}%`}
          hint={cost.failedCalls > 0 ? `${cost.failedCalls} failed call${cost.failedCalls === 1 ? "" : "s"}` : "of spend"}
          tone={cost.batchSharePct > 0 ? "good" : undefined}
        />
      )}
    </div>
  );
}

/** Research/draft split of a projection, with the measured-vs-estimated provenance shown. */
export function EstimateTable({ estimate }: { estimate: CostEstimate }) {
  const rows: Array<[string, typeof estimate.research]> = [
    ["Research", estimate.research],
    ["Drafting", estimate.draft],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
            <th className="py-1.5 pr-3 font-medium">Stage</th>
            <th className="py-1.5 pr-3 text-right font-medium">Calls</th>
            <th className="py-1.5 pr-3 text-right font-medium">Input</th>
            <th className="py-1.5 pr-3 text-right font-medium">Output</th>
            <th className="py-1.5 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, line]) => (
            <tr key={label} className="border-b border-gray-100">
              <td className="py-1.5 pr-3">
                {label}
                <span className="ml-1.5 text-[11px] text-gray-400">{line.measured ? "measured" : "estimated"}</span>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{line.calls.toLocaleString()}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{formatTokens(line.inputTokens + line.cachedInputTokens)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{formatTokens(line.outputTokens)}</td>
              <td className="py-1.5 text-right font-medium tabular-nums">{formatUsd(line.microUsd)}</td>
            </tr>
          ))}
          <tr>
            <td className="py-1.5 pr-3 font-medium">Remaining total</td>
            <td />
            <td />
            <td className="py-1.5 pr-3 text-right text-xs text-gray-500">{formatTokens(estimate.totalTokens)} tokens</td>
            <td className="py-1.5 text-right font-semibold tabular-nums">{formatUsd(estimate.totalMicroUsd)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Spend grouped by the model that produced it. */
export function CostByModelTable({ rows }: { rows: CostByModel[] }) {
  if (!rows.length) return <p className="text-sm text-gray-500">No model calls recorded yet.</p>;
  const total = rows.reduce((a, r) => a + r.microUsd, 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
            <th className="py-1.5 pr-3 font-medium">Model</th>
            <th className="py-1.5 pr-3 text-right font-medium">Calls</th>
            <th className="py-1.5 pr-3 text-right font-medium">Tokens</th>
            <th className="py-1.5 pr-3 text-right font-medium">Cost</th>
            <th className="py-1.5 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.modelKey}-${r.batch}`} className={"border-b border-gray-100 " + (r.batch ? "bg-emerald-50/50" : "")}>
              <td className="py-1.5 pr-3">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{r.label}</span>
                  {r.batch && <BatchTag />}
                </span>
                <span className="text-[11px] text-gray-400">{PROVIDER_LABELS[r.provider]}</span>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{r.calls.toLocaleString()}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{formatTokens(r.inputTokens + r.cachedInputTokens + r.outputTokens)}</td>
              <td className="py-1.5 pr-3 text-right font-medium tabular-nums">{formatUsd(r.microUsd)}</td>
              <td className="py-1.5 text-right tabular-nums text-gray-500">{total > 0 ? `${Math.round((r.microUsd / total) * 100)}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Which models a campaign resolved to, and what it inherited. */
export function AiConfigSummary({ ai }: { ai: ResolvedAiConfig }) {
  const inherited = (k: string) => !ai.overridden.includes(k as never);
  const row = (label: string, value: string, key: string, batch?: boolean) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium">{value}</span>
      {batch && <BatchTag />}
      {inherited(key) && <span className="text-[11px] text-gray-400">inherited</span>}
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-1 text-sm md:grid-cols-2">
      {row("Research model", ai.researchModelLabel, "researchModel", ai.researchBatch)}
      {row("Drafting model", ai.draftModelLabel, "draftModel", ai.draftBatch)}
      {row("Research depth", ai.researchMode, "researchMode")}
      {ai.usesBatch && row("Batch grouping", BATCH_STRATEGY_LABELS[ai.batchStrategy], "batchStrategy")}
    </div>
  );
}

const BATCH_STATUS_TONE: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  submitted: "bg-blue-100 text-blue-800",
  processing: "bg-blue-100 text-blue-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-gray-100 text-gray-600",
  expired: "bg-amber-100 text-amber-800",
};

export function BatchList({ batches }: { batches: BatchDto[] }) {
  if (!batches.length) return <p className="text-sm text-gray-500">No batches have been submitted for this campaign.</p>;
  return (
    <div className="space-y-2">
      {batches.map((b) => (
        <div key={b.id} className="rounded-md border border-gray-200 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + (BATCH_STATUS_TONE[b.status] ?? "bg-gray-100 text-gray-700")}>
              {b.status}
            </span>
            <span className="font-medium">{b.purpose}</span>
            <span className="text-gray-500">
              {b.model} · {b.requestCount} request{b.requestCount === 1 ? "" : "s"}
            </span>
            <span className="ml-auto font-medium tabular-nums">{formatUsd(b.microUsd)}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500">
            {b.submittedAt ? `submitted ${relativeTime(b.submittedAt)}` : "not submitted yet"}
            {b.completedAt && ` · finished ${relativeTime(b.completedAt)}`}
            {b.status === "completed" && ` · ${b.succeeded} ok, ${b.errored} failed`}
            {!b.completedAt && b.lastPolledAt && ` · last checked ${relativeTime(b.lastPolledAt)}`}
          </div>
          {b.error && <div className="mt-1 text-[11px] text-red-700">{b.error}</div>}
        </div>
      ))}
    </div>
  );
}

/** The campaign Cost tab: spend, projection, model breakdown and batch state. */
export function CampaignCostTab({ campaignId }: { campaignId: string }) {
  const q = useQuery({
    queryKey: ["campaigns", campaignId, "cost"],
    queryFn: () => api.get<CampaignCostDto>(`/api/campaigns/${campaignId}/cost`),
    // Batches land asynchronously, so keep this fresh while one is open.
    refetchInterval: 30_000,
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={(q.error as Error).message} />;
  const d = q.data!;
  const openBatch = d.batches.find((b) => b.status === "submitted" || b.status === "processing" || b.status === "pending");
  const projected = d.actual.totalMicroUsd + d.estimate.totalMicroUsd;

  return (
    <div className="space-y-4">
      {openBatch && (
        <Banner kind="info">
          A {openBatch.purpose} batch of {openBatch.requestCount} request{openBatch.requestCount === 1 ? "" : "s"} is
          {openBatch.status === "pending" ? " waiting to be submitted" : " being processed by the provider"}. Batch results
          usually arrive within an hour and can take up to 24, so drafts will appear later rather than immediately.
        </Banner>
      )}

      <section className="card space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Spend</h2>
          <span className="text-xs text-gray-500">
            Projected total when the campaign finishes: <strong className="tabular-nums">{formatUsd(projected)}</strong>
          </span>
        </div>
        <CostSummaryTiles cost={d.actual} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Still to spend</h2>
        <p className="text-xs text-gray-500">
          What the remaining research and drafting is expected to cost. Stages marked "measured" use this campaign's own
          observed averages; the rest use the research-depth profile.
        </p>
        <EstimateTable estimate={d.estimate} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Configuration</h2>
        <AiConfigSummary ai={d.ai} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">By model</h2>
        <CostByModelTable rows={d.byModel} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Batches</h2>
        <BatchList batches={d.batches} />
      </section>
    </div>
  );
}
