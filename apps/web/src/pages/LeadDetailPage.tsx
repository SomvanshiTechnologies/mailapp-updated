import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsd, type LeadDetailDto, type LeadDto } from "@mailapp/shared";
import { api } from "../lib/api";
import { formatDate, fullName } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { StatusBadge } from "../components/StatusBadge";
import { ValidationIssues } from "../components/ReviewQueue";
import { ConfirmDialog, ErrorBox, JsonView, KeyValue, PageHeader, Spinner } from "../components/ui";

type Action = "retry" | "skip" | "mark-replied" | "unsubscribe" | "research";

const ACTIONS: Array<{ key: Action; label: string; confirm: string; danger?: boolean }> = [
  { key: "retry", label: "Retry", confirm: "Re-queue research/drafting for this lead?" },
  { key: "research", label: "Re-research", confirm: "Run research again now? The persona will be replaced." },
  { key: "mark-replied", label: "Mark replied", confirm: "Mark as replied and stop all follow-ups?" },
  { key: "skip", label: "Skip", confirm: "Skip this lead? No further emails will be sent." },
  { key: "unsubscribe", label: "Unsubscribe", confirm: "Add this address to the suppression list and stop all sending?", danger: true },
];

export function LeadDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { canWrite } = useAuth();
  const [pending, setPending] = useState<Action | null>(null);
  const q = useQuery({
    queryKey: ["leads", "detail", id],
    queryFn: () => api.get<{ lead: LeadDetailDto }>(`/api/leads/${id}`),
    refetchInterval: 20_000,
  });
  const act = useMutation({
    mutationFn: (a: Action) => api.post<{ lead: LeadDto }>(`/api/leads/${id}/${a}`, a === "mark-replied" ? {} : undefined),
    onSuccess: () => {
      toast.success("Done");
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (e) => toast.error(e),
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={(q.error as Error).message} />;
  const lead = q.data!.lead;
  const p = lead.persona;
  const thread = [...lead.emails].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="space-y-4">
      <PageHeader
        title={fullName(lead.firstName, lead.lastName)}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={lead.status} />
            {lead.jobTitle ? `${lead.jobTitle} · ` : ""}
            {lead.company ?? ""} · {lead.email} ·{" "}
            <Link to={`/campaigns/${lead.campaignId}`} className="text-brand-700 hover:underline">
              campaign
            </Link>
          </span>
        }
        actions={
          canWrite && (
            <>
              {ACTIONS.map((a) => (
                <button key={a.key} className={a.danger ? "btn-secondary text-red-700" : "btn-secondary"} disabled={act.isPending} onClick={() => setPending(a.key)}>
                  {a.label}
                </button>
              ))}
            </>
          )
        }
      />
      {lead.lastError && <ErrorBox message={`Last error: ${lead.lastError}`} />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4">
          <div className="card">
            <h2 className="mb-2 text-sm font-semibold">Profile</h2>
            <KeyValue
              items={[
                ["Email", lead.email],
                ["Company", lead.company],
                ["Website", lead.website ? <a className="text-brand-700 hover:underline" href={lead.website} target="_blank" rel="noreferrer">{lead.website}</a> : null],
                ["Title", lead.jobTitle],
                ["LinkedIn", lead.linkedinUrl ? <a className="text-brand-700 hover:underline" href={lead.linkedinUrl} target="_blank" rel="noreferrer">profile</a> : null],
                ["Industry", lead.industry],
                ["Location", lead.location],
                ["Phone", lead.phone],
                ["Notes", lead.notes],
                ["Row", String(lead.rowNumber)],
                ["Step", String(lead.currentStep)],
                ["Next follow-up", formatDate(lead.nextActionAt)],
                ["Scheduled send", formatDate(lead.nextSendAt)],
              ]}
            />
            {Object.keys(lead.extra).length > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-xs font-semibold text-gray-500">Extra columns</div>
                <KeyValue items={Object.entries(lead.extra).map(([k, v]) => [k, v])} />
              </div>
            )}
          </div>
          <div className="card">
            <h2 className="mb-2 text-sm font-semibold">Model cost</h2>
            <KeyValue
              items={[
                ["Research", formatUsd(lead.researchMicroUsd)],
                ["Drafting", formatUsd(lead.totalMicroUsd - lead.researchMicroUsd)],
                ["Total for this lead", <strong className="tabular-nums">{formatUsd(lead.totalMicroUsd)}</strong>],
              ]}
            />
          </div>
          <div className="card">
            <h2 className="mb-2 text-sm font-semibold">Milestones</h2>
            <KeyValue
              items={[
                ["Sent", formatDate(lead.sentAt)],
                ["Delivered", formatDate(lead.deliveredAt)],
                ["Opened", formatDate(lead.openedAt)],
                ["Clicked", formatDate(lead.clickedAt)],
                ["Replied", formatDate(lead.repliedAt)],
                ["Bounced", formatDate(lead.bouncedAt)],
                ["Complained", formatDate(lead.complainedAt)],
                ["Unsubscribed", formatDate(lead.unsubscribedAt)],
              ]}
            />
          </div>
          {lead.matchedServices && lead.matchedServices.length > 0 && (
            <div className="card">
              <h2 className="mb-2 text-sm font-semibold">Matched services</h2>
              <ul className="space-y-2">
                {lead.matchedServices.map((m) => (
                  <li key={m.serviceId} className="rounded border border-gray-200 p-2 text-sm">
                    <div className="flex justify-between">
                      <span className="font-medium">{m.serviceName}</span>
                      <span className="text-xs text-gray-500">fit {m.fitScore}/10</span>
                    </div>
                    <p className="text-xs text-gray-700">{m.rationale}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-4 xl:col-span-2">
          <div className="card">
            <h2 className="mb-2 text-sm font-semibold">
              Persona {p && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal text-gray-600">confidence: {p.confidence}</span>}
            </h2>
            {!p ? (
              <p className="text-sm text-gray-500">No research yet.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
                <div className="md:col-span-2">
                  <div className="text-xs font-semibold text-gray-500">Company</div>
                  <p>{p.companySummary}</p>
                  <div className="mt-1 text-xs text-gray-600">
                    {p.industry} · {p.companySizeSignal}
                  </div>
                </div>
                <div className="md:col-span-2">
                  <div className="text-xs font-semibold text-gray-500">Person</div>
                  <p>{p.personRoleSummary}</p>
                </div>
                <PersonaList title="Personalisation hooks" items={p.personalisationHooks} />
                <PersonaList title="Pain points" items={p.painPoints} />
                <PersonaList title="Likely priorities" items={p.likelyPriorities} />
                <PersonaList title="Recent signals" items={p.recentSignals} />
                <PersonaList title="Offering" items={p.companyOffering} />
                <div>
                  <div className="text-xs font-semibold text-gray-500">Sources</div>
                  <ul className="list-disc pl-4 text-xs">
                    {p.sources.map((s) => (
                      <li key={s} className="truncate">
                        <a className="text-brand-700 hover:underline" href={s} target="_blank" rel="noreferrer">
                          {s}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
                {p.notes && (
                  <div className="md:col-span-2 text-xs text-gray-600">
                    <span className="font-semibold">Notes: </span>
                    {p.notes}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="mb-2 text-sm font-semibold">Email thread</h2>
            {thread.length === 0 ? (
              <p className="text-sm text-gray-500">No emails yet.</p>
            ) : (
              <div className="space-y-3">
                {thread.map((e) => (
                  <div key={e.id} className={"rounded-md border p-3 " + (e.direction === "inbound" ? "border-green-200 bg-green-50" : "border-gray-200")}>
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                      <span className="font-medium text-gray-800">{e.direction === "inbound" ? "Reply received" : `Step ${e.step} · outbound`}</span>
                      <StatusBadge status={e.status} />
                      {e.sentAt && <span>sent {formatDate(e.sentAt)}</span>}
                      {!e.sentAt && (e.status === "queued" || e.status === "approved") && (
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-800">
                          {e.scheduledFor ? `scheduled for ${formatDate(e.scheduledFor)}` : lead.nextSendAt ? `sending at ${formatDate(lead.nextSendAt)}` : "sending soon"}
                        </span>
                      )}
                      {e.sesMessageId && <span className="font-mono">SES {e.sesMessageId}</span>}
                      {e.reviewedBy && <span>reviewed {formatDate(e.reviewedAt)}</span>}
                    </div>
                    <div className="text-sm font-medium">{e.subject}</div>
                    <pre className="mt-1 whitespace-pre-wrap font-sans text-sm text-gray-800">{e.bodyText}</pre>
                    {e.error && <div className="mt-1 text-xs text-red-700">{e.error}</div>}
                    {e.reviewNote && <div className="mt-1 text-xs text-gray-600">Review note: {e.reviewNote}</div>}
                    <div className="mt-2">
                      <ValidationIssues validation={e.validation} />
                    </div>
                    {e.llmMeta && <div className="mt-2"><JsonView value={e.llmMeta} label="LLM metadata" /></div>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="mb-2 text-sm font-semibold">Events</h2>
            {lead.events.length === 0 ? (
              <p className="text-sm text-gray-500">No SES events yet.</p>
            ) : (
              <ol className="space-y-1 text-sm">
                {[...lead.events]
                  .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
                  .map((ev) => (
                    <li key={ev.id} className="flex flex-wrap items-center gap-2 border-b border-gray-100 py-1">
                      <span className="w-40 text-xs text-gray-500">{formatDate(ev.occurredAt)}</span>
                      <StatusBadge status={ev.eventType.toLowerCase()} />
                      {ev.subType && <span className="text-xs text-gray-600">{ev.subType}</span>}
                      <span className="font-mono text-xs text-gray-400">{ev.sesMessageId}</span>
                      <div className="ml-auto">
                        <JsonView value={ev.payload} label="payload" />
                      </div>
                    </li>
                  ))}
              </ol>
            )}
          </div>

          <div className="card">
            <h2 className="mb-2 text-sm font-semibold">Send attempts</h2>
            {lead.attempts.length === 0 ? (
              <p className="text-sm text-gray-500">No send attempts.</p>
            ) : (
              <div className="space-y-2">
                {lead.attempts.map((a) => (
                  <div key={a.id} className="rounded border border-gray-200 p-2 text-xs">
                    <div className="mb-1 flex gap-3 text-gray-600">
                      <span>Attempt {a.attemptNo}</span>
                      <span>{formatDate(a.createdAt)}</span>
                      <span>{a.durationMs} ms</span>
                      <span className={a.error ? "text-red-700" : "text-green-700"}>{a.error ? "error" : "ok"}</span>
                    </div>
                    <JsonView value={{ request: a.request, response: a.response, error: a.error }} label="Request / response" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={ACTIONS.find((a) => a.key === pending)?.label ?? ""}
        message={ACTIONS.find((a) => a.key === pending)?.confirm ?? ""}
        danger={ACTIONS.find((a) => a.key === pending)?.danger}
        busy={act.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) act.mutate(pending);
          setPending(null);
        }}
      />
    </div>
  );
}

function PersonaList({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="text-xs font-semibold text-gray-500">{title}</div>
      <ul className="list-disc pl-4">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
