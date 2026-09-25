import { useQuery } from "@tanstack/react-query";
import type { SystemStatus } from "@mailapp/shared";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { Banner, ErrorBox, KeyValue, PageHeader, Spinner } from "../components/ui";

export function SystemPage() {
  const q = useQuery({
    queryKey: ["system", "status"],
    queryFn: () => api.get<SystemStatus>("/api/system/status"),
    refetchInterval: 15_000,
  });
  const ready = useQuery({
    queryKey: ["system", "ready"],
    queryFn: () => api.get<{ ok: boolean; db: string; queue: string }>("/readyz"),
    refetchInterval: 15_000,
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={(q.error as Error).message} />;
  const s = q.data!;
  return (
    <div className="space-y-4">
      <PageHeader title="System" subtitle={`Server time ${formatDate(s.now)}`} />
      {s.sesMode === "mock" && (
        <Banner kind="warning">
          <strong>SES is in mock mode.</strong> No email leaves this system; message ids are fake. Set <code>SES_MODE=ses</code> with valid AWS
          credentials for real sending.
        </Banner>
      )}
      {s.llmProvider === "mock" && (
        <Banner kind="warning">
          <strong>LLM provider is mock.</strong> Research and drafts are placeholder text. Set <code>LLM_PROVIDER=anthropic</code> and{" "}
          <code>ANTHROPIC_API_KEY</code>.
        </Banner>
      )}
      {(s.db !== "ok" || s.queue !== "ok") && <Banner kind="danger">Database or queue is unhealthy: db={s.db}, queue={s.queue}</Banner>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="card">
          <h2 className="mb-2 text-sm font-semibold">Runtime</h2>
          <KeyValue
            items={[
              ["Version", s.version],
              ["Environment", s.env],
              ["LLM provider", s.llmProvider],
              ["SES mode", s.sesMode],
              ["Database", s.db],
              ["Queue", s.queue],
              ["Readiness", ready.data ? (ready.data.ok ? "ready" : "not ready") : "…"],
              ["Last SES sync", formatDate(s.lastSesSyncAt)],
              ["Sent today", `${s.sentToday} / ${s.dailyCap}`],
              ["Reply capture (SES)", s.replyCapture.inboundDomain ?? "not configured"],
            ]}
          />
          {s.replyCapture.imapAccounts.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-xs font-semibold text-gray-500">IMAP mailboxes polled</div>
              <ul className="space-y-1 text-xs">
                {s.replyCapture.imapAccounts.map((a) => (
                  <li key={a.key} className={a.lastError ? "text-red-700" : "text-gray-700"}>
                    {a.label} · last poll {formatDate(a.lastPolledAt)}
                    {a.lastError ? ` · ${a.lastError}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="card">
          <h2 className="mb-2 text-sm font-semibold">Queues</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Queue</th>
                <th className="text-right">Waiting</th>
                <th className="text-right">Active</th>
                <th className="text-right">Retry</th>
                <th className="text-right">Completed</th>
                <th className="text-right">Failed</th>
              </tr>
            </thead>
            <tbody>
              {s.queues.map((qs) => (
                <tr key={qs.queue}>
                  <td className="font-mono text-xs">{qs.queue}</td>
                  <td className="text-right tabular-nums">{qs.created}</td>
                  <td className="text-right tabular-nums">{qs.active}</td>
                  <td className="text-right tabular-nums">{qs.retry}</td>
                  <td className="text-right tabular-nums">{qs.completed}</td>
                  <td className={"text-right tabular-nums " + (qs.failed ? "font-medium text-red-700" : "")}>{qs.failed}</td>
                </tr>
              ))}
              {s.queues.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-gray-500">
                    No queue statistics available
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
