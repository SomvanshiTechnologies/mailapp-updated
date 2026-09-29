import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CAMPAIGN_STATUSES, formatUsd, type CampaignDto } from "@mailapp/shared";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState, ErrorBox, PageHeader, Spinner } from "../components/ui";

export function CampaignsPage() {
  const { canWrite, isAdmin } = useAuth();
  const [status, setStatus] = useState<string>("");
  const q = useQuery({
    queryKey: ["campaigns", status],
    queryFn: () => api.get<{ items: CampaignDto[] }>("/api/campaigns", { status: status || undefined }),
    refetchInterval: 30_000,
  });

  return (
    <div>
      <PageHeader
        title="Campaigns"
        subtitle={isAdmin ? "All campaigns" : "Campaigns you created or were given access to"}
        actions={
          <>
            <select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              {CAMPAIGN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {canWrite && (
              <Link to="/campaigns/new" className="btn-primary">
                New campaign
              </Link>
            )}
          </>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox message={(q.error as Error).message} />
      ) : !q.data?.items.length ? (
        <EmptyState
          title="No campaigns yet"
          hint={canWrite ? "Upload a lead sheet to create your first campaign." : "An administrator can grant you access to a campaign."}
        />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Approval</th>
                <th className="text-right">Leads</th>
                <th className="text-right">Review</th>
                <th className="text-right">Sent</th>
                <th className="text-right">Delivered</th>
                <th className="text-right">Opened</th>
                <th className="text-right">Replied</th>
                <th className="text-right">Bounced</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Per email</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/campaigns/${c.id}`} className="font-medium text-brand-700 hover:underline">
                      {c.name}
                    </Link>
                    {c.sourceFileName && <div className="text-xs text-gray-500">{c.sourceFileName}</div>}
                  </td>
                  <td className="text-xs">
                    {c.createdByName ?? <span className="text-gray-400">—</span>}
                    {c.myAccess !== "full" && <div className="text-gray-400">{c.myAccess} access</div>}
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="text-xs">{c.approvalMode}</td>
                  <td className="text-right tabular-nums">{c.counts.total}</td>
                  <td className={"text-right tabular-nums " + (c.counts.pendingReview ? "font-medium text-amber-700" : "")}>{c.counts.pendingReview}</td>
                  <td className="text-right tabular-nums">{c.counts.sent}</td>
                  <td className="text-right tabular-nums">{c.counts.delivered}</td>
                  <td className="text-right tabular-nums">{c.counts.opened}</td>
                  <td className="text-right tabular-nums">{c.counts.replied}</td>
                  <td className="text-right tabular-nums">{c.counts.bounced}</td>
                  <td className="text-right tabular-nums" title={`${c.ai.researchModelLabel} for research, ${c.ai.draftModelLabel} for drafting`}>
                    {formatUsd(c.cost.totalMicroUsd)}
                    {c.ai.usesBatch && <span className="ml-1 text-[10px] text-emerald-700">batch</span>}
                  </td>
                  <td className="text-right tabular-nums text-xs text-gray-600">{formatUsd(c.cost.perEmailMicroUsd)}</td>
                  <td className="text-xs text-gray-500">{formatDate(c.createdAt, false)}</td>
                  <td className="whitespace-nowrap text-right">
                    {c.status === "draft" && c.myAccess === "full" ? (
                      <Link to={`/campaigns/${c.id}?tab=settings`} className="btn-secondary btn-sm" title="Draft campaigns can be edited until they are started">
                        Edit
                      </Link>
                    ) : (
                      <span className="text-xs text-gray-400" title="Settings lock once a campaign is started">
                        {c.status === "draft" ? "" : "locked"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
