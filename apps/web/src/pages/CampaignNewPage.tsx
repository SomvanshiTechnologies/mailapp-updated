import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CreateCampaignSchema,
  DEFAULT_SEQUENCE,
  type ApprovalMode,
  type CampaignDto,
  type ServiceDto,
  type SequenceStep,
} from "@mailapp/shared";
import { api, errorMessage } from "../lib/api";
import { useToast } from "../hooks/useToast";
import { HeaderMappingPreview, type PreviewResult } from "../components/HeaderMappingPreview";
import { SequenceEditor, validateSequence } from "../components/SequenceEditor";
import { ChipsInput } from "../components/ChipsInput";
import { ErrorBox, Field, PageHeader, Spinner } from "../components/ui";

type Step = 1 | 2 | 3;

export function CampaignNewPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("manual");
  const [sequence, setSequence] = useState<SequenceStep[]>(DEFAULT_SEQUENCE);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [extraGuidance, setExtraGuidance] = useState("");
  const [maxWords, setMaxWords] = useState<string>("");
  const [bannedPhrases, setBannedPhrases] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const services = useQuery({
    queryKey: ["services"],
    queryFn: () => api.get<{ items: ServiceDto[] }>("/api/services"),
  });

  const previewMut = useMutation({
    mutationFn: (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      return api.upload<PreviewResult>("/api/campaigns/preview", fd);
    },
    onSuccess: (p) => setPreview(p),
    onError: (e) => toast.error(e, "Preview failed"),
  });

  const create = useMutation({
    mutationFn: (payload: unknown) => {
      const fd = new FormData();
      fd.append("file", file!);
      fd.append("payload", JSON.stringify(payload));
      return api.upload<{ campaign: CampaignDto }>("/api/campaigns", fd);
    },
    onSuccess: (r) => {
      toast.success("Campaign created");
      navigate(`/campaigns/${r.campaign.id}`);
    },
    onError: (e) => toast.error(e, "Create failed"),
  });

  const buildPayload = () => {
    const hardRulesOverride: Record<string, unknown> = {};
    if (maxWords.trim()) hardRulesOverride.maxWords = Number(maxWords);
    if (bannedPhrases.length) hardRulesOverride.bannedPhrases = bannedPhrases;
    const raw = {
      name,
      description,
      approvalMode,
      sequence,
      serviceIds,
      fromEmail: fromEmail || undefined,
      fromName: fromName || undefined,
      replyTo: replyTo || undefined,
      extraGuidance,
      hardRulesOverride: Object.keys(hardRulesOverride).length ? hardRulesOverride : undefined,
    };
    const parsed = CreateCampaignSchema.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new Error(`${i.path.join(".") || "form"}: ${i.message}`);
    }
    return parsed.data;
  };

  const goToReview = () => {
    setFormError(null);
    try {
      buildPayload();
      setStep(3);
    } catch (e) {
      setFormError(errorMessage(e));
    }
  };

  const canProceedFromUpload = !!file && !!preview && preview.missingRequired.length === 0 && preview.totalRows > 0;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="New campaign" subtitle={`Step ${step} of 3 — ${step === 1 ? "Upload leads" : step === 2 ? "Configure" : "Review & create"}`} />

      {step === 1 && (
        <div className="card space-y-4">
          <Field label="Lead sheet (.xlsx)" hint="Required column: email. Recognised: first name, last name, company, website, job title, linkedin, industry, location, phone, notes. Other columns are kept as extra data.">
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                setPreview(null);
                if (f) previewMut.mutate(f);
              }}
            />
          </Field>
          {previewMut.isPending && <Spinner label="Analysing sheet…" />}
          {preview && <HeaderMappingPreview preview={preview} />}
          <div className="flex justify-end">
            <button className="btn-primary" disabled={!canProceedFromUpload} onClick={() => setStep(2)}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="card space-y-4">
            <h2 className="text-sm font-semibold">Basics</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Campaign name">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field label="Approval mode" hint="Manual: every draft waits in the review queue. Auto: drafts that pass validation are sent automatically.">
                <select className="input" value={approvalMode} onChange={(e) => setApprovalMode(e.target.value as ApprovalMode)}>
                  <option value="manual">Manual review</option>
                  <option value="auto">Auto-send</option>
                </select>
              </Field>
            </div>
            <Field label="Description">
              <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>

          <div className="card space-y-3">
            <h2 className="text-sm font-semibold">Follow-up sequence</h2>
            <SequenceEditor value={sequence} onChange={setSequence} />
          </div>

          <div className="card space-y-3">
            <h2 className="text-sm font-semibold">Services to pitch</h2>
            <p className="text-xs text-gray-500">Leave empty to let the LLM choose from all active services.</p>
            {services.isLoading ? (
              <Spinner />
            ) : (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {(services.data?.items ?? [])
                  .filter((s) => s.isActive)
                  .map((s) => (
                    <label key={s.id} className="flex items-start gap-2 rounded border border-gray-200 p-2 text-sm">
                      <input
                        type="checkbox"
                        checked={serviceIds.includes(s.id)}
                        onChange={(e) => setServiceIds(e.target.checked ? [...serviceIds, s.id] : serviceIds.filter((x) => x !== s.id))}
                      />
                      <span>
                        <span className="font-medium">{s.name}</span>
                        <span className="block text-xs text-gray-500">{s.description.slice(0, 120)}</span>
                      </span>
                    </label>
                  ))}
                {services.data && services.data.items.filter((s) => s.isActive).length === 0 && (
                  <p className="text-sm text-amber-700">No active services. Add services first so drafts can pitch something.</p>
                )}
              </div>
            )}
          </div>

          <div className="card space-y-4">
            <h2 className="text-sm font-semibold">Sender & guidance (optional)</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="From email" hint="Defaults to global settings">
                <input className="input" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} />
              </Field>
              <Field label="From name">
                <input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} />
              </Field>
              <Field label="Reply-to">
                <input className="input" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />
              </Field>
            </div>
            <Field label="Extra guidance for this campaign" hint="Appended to the global instruction documents.">
              <textarea className="input" rows={3} value={extraGuidance} onChange={(e) => setExtraGuidance(e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[10rem_1fr]">
              <Field label="Max words override">
                <input className="input" type="number" min={20} max={1000} value={maxWords} onChange={(e) => setMaxWords(e.target.value)} />
              </Field>
              <Field label="Additional banned phrases">
                <ChipsInput value={bannedPhrases} onChange={setBannedPhrases} />
              </Field>
            </div>
          </div>

          {formError && <ErrorBox message={formError} />}
          <div className="flex justify-between">
            <button className="btn-secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn-primary" disabled={!name.trim() || validateSequence(sequence).length > 0} onClick={goToReview}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 3 && preview && (
        <div className="space-y-4">
          <div className="card space-y-2 text-sm">
            <h2 className="text-sm font-semibold">Summary</h2>
            <div>
              <span className="text-gray-500">File:</span> {file?.name} · {preview.totalRows} rows
            </div>
            <div>
              <span className="text-gray-500">Name:</span> {name}
            </div>
            <div>
              <span className="text-gray-500">Approval:</span> {approvalMode}
            </div>
            <div>
              <span className="text-gray-500">Sequence:</span> {sequence.length} step(s) —{" "}
              {sequence.map((s) => (s.step === 1 ? "day 0" : `+${s.delayDays}d`)).join(", ")}
            </div>
            <div>
              <span className="text-gray-500">Services:</span> {serviceIds.length ? `${serviceIds.length} selected` : "all active"}
            </div>
          </div>
          <div className="flex justify-between">
            <button className="btn-secondary" onClick={() => setStep(2)} disabled={create.isPending}>
              Back
            </button>
            <button
              className="btn-primary"
              disabled={create.isPending}
              onClick={() => {
                try {
                  create.mutate(buildPayload());
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              {create.isPending ? "Creating…" : "Create campaign"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
