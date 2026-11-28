import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EvidenceItem, LeadDto, QualificationOutcome, ServiceDto } from "@mailapp/shared";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { useToast } from "../hooks/useToast";

const OUTCOME: Record<QualificationOutcome, { label: string; cls: string; hint: string }> = {
  qualified: { label: "Qualified", cls: "bg-green-100 text-green-800", hint: "Sent on to email drafting." },
  unqualified: { label: "Unqualified", cls: "bg-gray-100 text-gray-700", hint: "Not contacted. Qualify it by hand to override." },
  needs_research: { label: "Needs additional research", cls: "bg-amber-100 text-amber-800", hint: "On hold. Re-research, or decide by hand." },
  human_review: { label: "Human review", cls: "bg-amber-100 text-amber-800", hint: "On hold until someone qualifies or disqualifies it." },
};

const ASSESSMENT: Record<string, string> = { met: "text-green-700", not_met: "text-red-700", unknown: "text-gray-500" };

/** Lead statuses in which the decision can still be changed (nothing drafted yet). */
const DECIDABLE = new Set(["researched", "qualified", "unqualified", "on_hold"]);

function EvidenceRefs({ items }: { items: EvidenceItem[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
      {items.map((e, i) => (
        <li key={i}>
          <span className={e.basis === "verified" ? "font-semibold text-green-700" : "text-gray-500"}>{e.basis}</span> · {e.claim}
          {e.sourceUrl && (
            <a className="ml-1 text-brand-700 hover:underline" href={e.sourceUrl} target="_blank" rel="noreferrer">
              source
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export function QualificationCard({ lead, canWrite }: { lead: LeadDto; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = lead.qualification;
  const [serviceId, setServiceId] = useState<string>("");
  const [note, setNote] = useState("");
  const decidable = canWrite && DECIDABLE.has(lead.status) && Boolean(lead.persona);
  const services = useQuery({
    queryKey: ["services"],
    queryFn: () => api.get<{ items: ServiceDto[] }>("/api/services"),
    enabled: decidable,
  });
  const decide = useMutation({
    mutationFn: (decision: "qualify" | "disqualify") =>
      api.post(`/api/leads/${lead.id}/qualification`, {
        decision,
        ...(decision === "qualify" && serviceId ? { serviceId: serviceId === "none" ? null : serviceId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success("Decision saved");
      setNote("");
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (e) => toast.error(e),
  });

  return (
    <div className="card">
      <h2 className="mb-2 text-sm font-semibold">
        Qualification
        {q && <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-normal ${OUTCOME[q.outcome].cls}`}>{OUTCOME[q.outcome].label}</span>}
        {q && <span className="ml-2 text-xs font-normal text-gray-500">by {q.decidedBy === "human" ? q.decidedByUser : q.decidedBy === "rules" ? "rules" : "AI"} · {formatDate(q.decidedAt)}</span>}
      </h2>
      {!q ? (
        <p className="text-sm text-gray-500">{lead.status === "qualifying" ? "Qualifying…" : "Not qualified yet."}</p>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-gray-500">{OUTCOME[q.outcome].hint}</p>
          {q.summary && <p>{q.summary}</p>}

          <div>
            <div className="text-xs font-semibold text-gray-500">Recommended service</div>
            {q.service ? (
              <div className="rounded border border-gray-200 p-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{q.service.serviceName}</span>
                  <span className="text-xs text-gray-600">fit {q.service.fitScore}/10</span>
                </div>
                <p className="text-xs text-gray-700">{q.service.rationale}</p>
                <EvidenceRefs items={q.service.supportingEvidence} />
              </div>
            ) : (
              <p className="text-xs text-gray-600">None. {q.noServiceReason}</p>
            )}
          </div>

          {q.criteria.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-500">Criteria</div>
              <ul className="space-y-1">
                {q.criteria.map((c, i) => (
                  <li key={i}>
                    <span className={`text-xs font-semibold uppercase ${ASSESSMENT[c.assessment]}`}>{c.assessment.replace("_", " ")}</span> {c.criterion}
                    {c.note && <span className="text-xs text-gray-500"> · {c.note}</span>}
                    <EvidenceRefs items={c.evidence} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {q.adjustments.length > 0 && (
            <div className="rounded bg-amber-50 p-2 text-xs text-amber-900">
              <div className="font-semibold">Adjustments{q.modelOutcome && q.modelOutcome !== q.outcome ? ` (AI said: ${OUTCOME[q.modelOutcome].label})` : ""}</div>
              <ul className="list-disc pl-4">
                {q.adjustments.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {decidable && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3">
          <label className="text-xs text-gray-600">
            Service
            <select className="input mt-1 block" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">{q?.service ? `Keep: ${q.service.serviceName}` : "Keep recommendation"}</option>
              {(services.data?.items ?? [])
                .filter((s) => s.isActive)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              <option value="none">No specific service</option>
            </select>
          </label>
          <label className="flex-1 text-xs text-gray-600">
            Note (optional)
            <input className="input mt-1 block w-full" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="btn-primary" disabled={decide.isPending} onClick={() => decide.mutate("qualify")}>
            Qualify
          </button>
          <button className="btn-secondary text-red-700" disabled={decide.isPending} onClick={() => decide.mutate("disqualify")}>
            Disqualify
          </button>
        </div>
      )}
    </div>
  );
}
