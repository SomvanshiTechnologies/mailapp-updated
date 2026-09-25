import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EmailDto, LeadDto, Paginated, ValidationResult } from "@mailapp/shared";
import { api } from "../lib/api";
import { fullName } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { StatusBadge } from "./StatusBadge";
import { EmptyState, ErrorBox, Modal, Pagination, Spinner } from "./ui";

type ReviewItem = EmailDto & { lead: LeadDto };

export function ValidationIssues({ validation }: { validation: ValidationResult | null }) {
  if (!validation || validation.issues.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-xs">
      {validation.issues.map((i, idx) => (
        <li key={idx} className={i.severity === "error" ? "text-red-700" : "text-amber-700"}>
          <span className="font-medium">{i.severity === "error" ? "Error" : "Warning"}</span> · {i.rule}: {i.message}
        </li>
      ))}
    </ul>
  );
}

function ReviewCard({ item, onChanged }: { item: ReviewItem; onChanged: () => void }) {
  const toast = useToast();
  const { canWrite } = useAuth();
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.bodyText);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [note, setNote] = useState("");
  const edited = subject !== item.subject || body !== item.bodyText;

  const approve = useMutation({
    mutationFn: () =>
      api.post(`/api/emails/${item.id}/approve`, edited ? { subject, bodyText: body } : {}),
    onSuccess: () => {
      toast.success("Approved and queued for sending");
      onChanged();
    },
    onError: (e) => toast.error(e, "Approve failed"),
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/api/emails/${item.id}/reject`, { note: note || undefined }),
    onSuccess: () => {
      toast.success("Rejected");
      setRejectOpen(false);
      onChanged();
    },
    onError: (e) => toast.error(e, "Reject failed"),
  });
  const regenerate = useMutation({
    mutationFn: () => api.post(`/api/emails/${item.id}/regenerate`, { feedback: note || undefined }),
    onSuccess: () => {
      toast.success("Regeneration queued");
      setRegenOpen(false);
      onChanged();
    },
    onError: (e) => toast.error(e, "Regenerate failed"),
  });
  const busy = approve.isPending || reject.isPending || regenerate.isPending;
  const lead = item.lead;
  const persona = lead.persona;

  return (
    <div className="card grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="space-y-3 text-sm">
        <div>
          <Link to={`/leads/${lead.id}`} className="font-medium text-brand-700 hover:underline">
            {fullName(lead.firstName, lead.lastName)}
          </Link>
          <div className="text-gray-600">
            {lead.jobTitle ? `${lead.jobTitle} · ` : ""}
            {lead.company ?? "—"}
          </div>
          <div className="text-xs text-gray-500">{lead.email}</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
            Step {item.step} <StatusBadge status={item.status} />
          </div>
        </div>
        {persona && (
          <div className="space-y-2 rounded-md bg-gray-50 p-3 text-xs">
            <div>
              <div className="font-semibold text-gray-600">Company</div>
              <p className="text-gray-800">{persona.companySummary}</p>
            </div>
            {persona.personalisationHooks.length > 0 && (
              <div>
                <div className="font-semibold text-gray-600">Hooks</div>
                <ul className="list-disc pl-4 text-gray-800">
                  {persona.personalisationHooks.slice(0, 4).map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            )}
            {persona.painPoints.length > 0 && (
              <div>
                <div className="font-semibold text-gray-600">Pain points</div>
                <ul className="list-disc pl-4 text-gray-800">
                  {persona.painPoints.slice(0, 3).map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="text-gray-500">Research confidence: {persona.confidence}</div>
          </div>
        )}
        {lead.matchedServices && lead.matchedServices.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-gray-600">Matched services</div>
            <ul className="mt-1 space-y-1">
              {lead.matchedServices.map((m) => (
                <li key={m.serviceId} className="rounded border border-gray-200 px-2 py-1 text-xs">
                  <span className="font-medium">{m.serviceName}</span>{" "}
                  <span className="text-gray-500">fit {m.fitScore}/10</span>
                  <p className="text-gray-700">{m.rationale}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {item.llmMeta && typeof item.llmMeta.pitchAngle === "string" && (
          <div className="text-xs">
            <span className="font-semibold text-gray-600">Pitch angle: </span>
            <span className="text-gray-800">{item.llmMeta.pitchAngle}</span>
          </div>
        )}
      </div>
      <div className="space-y-2">
        <div>
          <label className="label">Subject</label>
          <input className="input" value={subject} disabled={!canWrite} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <label className="label">Body</label>
          <textarea className="input font-mono text-xs" rows={14} value={body} disabled={!canWrite} onChange={(e) => setBody(e.target.value)} />
        </div>
        <ValidationIssues validation={item.validation} />
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button className="btn-primary" disabled={busy} onClick={() => approve.mutate()}>
              {edited ? "Save & approve" : "Approve"}
            </button>
            <button className="btn-secondary" disabled={busy} onClick={() => setRegenOpen(true)}>
              Regenerate
            </button>
            <button className="btn-secondary text-red-700" disabled={busy} onClick={() => setRejectOpen(true)}>
              Reject
            </button>
            {edited && <span className="text-xs text-amber-700">Unsaved edits</span>}
          </div>
        )}
      </div>
      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject draft"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setRejectOpen(false)}>
              Cancel
            </button>
            <button className="btn-danger" disabled={reject.isPending} onClick={() => reject.mutate()}>
              Reject
            </button>
          </>
        }
      >
        <label className="label">Note (optional)</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
      <Modal
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        title="Regenerate draft"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setRegenOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>
              Regenerate
            </button>
          </>
        }
      >
        <label className="label">Feedback for the LLM (optional)</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Too long, lead with the hiring signal, drop the second service" />
      </Modal>
    </div>
  );
}

export function ReviewQueue({ campaignId }: { campaignId?: string }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const q = useQuery({
    queryKey: ["emails", "review", campaignId ?? "all", page],
    queryFn: () =>
      api.get<Paginated<ReviewItem>>("/api/emails", { status: "pending_review", campaignId, page, pageSize }),
    refetchInterval: 30_000,
  });
  const changed = () => {
    qc.invalidateQueries({ queryKey: ["emails"] });
    qc.invalidateQueries({ queryKey: ["campaigns"] });
    qc.invalidateQueries({ queryKey: ["leads"] });
  };

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={String((q.error as Error).message)} />;
  const data = q.data!;
  if (data.total === 0) return <EmptyState title="Nothing to review" hint="Drafts appear here when a campaign in manual approval mode produces them." />;
  return (
    <div className="space-y-4">
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
      {data.items.map((item) => (
        <ReviewCard key={item.id + item.updatedAt} item={item} onChanged={changed} />
      ))}
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
    </div>
  );
}
