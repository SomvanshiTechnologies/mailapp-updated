import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { INSTRUCTION_KINDS, InstructionSchema, type InstructionDto, type InstructionKind, type InstructionScope } from "@mailapp/shared";
import { api } from "../lib/api";
import { formatDate, titleCase } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { Banner, ConfirmDialog, EmptyState, ErrorBox, Field, Modal, PageHeader, Spinner, Tabs } from "../components/ui";

const KIND_HELP: Record<InstructionKind, string> = {
  company_profile: "Who we are, what we do, credibility. Used as context in every draft.",
  tone: "Voice and tone guidance (e.g. warm, direct, no hype).",
  format: "Structure rules: length, paragraphs, greeting/sign-off, subject style.",
  rules: "Hard do/don't rules the drafter must follow (claims to avoid, compliance).",
  signature: "The signature block appended to every email.",
  followup_guidance: "How follow-ups should differ from the first email.",
  other: "Any other guidance.",
};

interface ListResponse {
  items: InstructionDto[];
  scope: InstructionScope;
  personalisedKinds: InstructionKind[];
}

/**
 * Two scopes: the organisation's documents (admin-managed, apply to everyone) and the
 * caller's own, which override the organisation's per kind for campaigns they create.
 */
export function InstructionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { canWrite, isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const scope = (params.get("scope") as InstructionScope) === "mine" ? "mine" : "org";
  const setScope = (s: InstructionScope) => setParams({ scope: s });
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<InstructionDto | "new" | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleting, setDeleting] = useState<InstructionDto | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const q = useQuery({
    queryKey: ["instructions", scope, includeInactive],
    queryFn: () => api.get<ListResponse>("/api/instructions", { scope, includeInactive: includeInactive || undefined }),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["instructions"] });
  const toggle = useMutation({
    mutationFn: (d: InstructionDto) => api.patch(`/api/instructions/${d.id}`, { isActive: !d.isActive }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/instructions/${id}`),
    onSuccess: () => {
      toast.success("Deleted");
      setDeleting(null);
      invalidate();
    },
    onError: (e) => toast.error(e),
  });
  const importMut = useMutation({
    mutationFn: (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("scope", scope);
      return api.upload<{ imported: number; skipped: Array<{ row: number; reason: string }> }>("/api/instructions/import", fd);
    },
    onSuccess: (r) => {
      toast.success(`Imported ${r.imported} document(s)${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`);
      invalidate();
    },
    onError: (e) => toast.error(e, "Import failed"),
  });

  // Who may change documents in the current scope.
  const canEditScope = scope === "org" ? isAdmin : canWrite;
  const personalised = new Set(q.data?.personalisedKinds ?? []);
  const grouped = new Map<InstructionKind, InstructionDto[]>();
  for (const d of q.data?.items ?? []) grouped.set(d.kind, [...(grouped.get(d.kind) ?? []), d]);

  return (
    <div>
      <PageHeader
        title="Instructions"
        subtitle="Tone, format, rules and profile documents injected into every draft"
        actions={
          <>
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
            </label>
            {canEditScope && (
              <>
                <input ref={importRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importMut.mutate(f); e.target.value = ""; }} />
                <button className="btn-secondary" disabled={importMut.isPending} title="Import from a settings export or any sheet with kind / title / content columns" onClick={() => importRef.current?.click()}>
                  Import xlsx
                </button>
                <button className="btn-secondary" onClick={() => setUploadOpen(true)}>
                  Upload file
                </button>
                <button className="btn-primary" onClick={() => setEditing("new")}>
                  New instruction
                </button>
              </>
            )}
          </>
        }
      />
      <Tabs<InstructionScope>
        tabs={[
          { key: "org", label: "Organisation" },
          { key: "mine", label: "Mine", count: q.data?.personalisedKinds.length || undefined },
        ]}
        value={scope}
        onChange={setScope}
      />
      {scope === "org" ? (
        <div className="mb-4">
          <Banner kind="info">
            Organisation documents apply to everyone and are managed by administrators.
            {personalised.size > 0 && <> You have personal overrides for: {[...personalised].map(titleCase).join(", ")}.</>}
          </Banner>
        </div>
      ) : (
        <div className="mb-4">
          <Banner kind="info">
            Your personal documents override the organisation's <em>for the kinds you define here</em>, on campaigns you create. Kinds you
            leave empty fall back to the organisation's documents.
          </Banner>
        </div>
      )}
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox message={(q.error as Error).message} />
      ) : !q.data?.items.length ? (
        <EmptyState
          title={scope === "org" ? "No organisation documents" : "No personal documents"}
          hint={
            scope === "org"
              ? "Add a company profile, tone guide, format rules and a signature so drafts match your voice."
              : "Add your own signature, tone or rules to personalise the campaigns you run. Or import a colleague's settings export."
          }
        />
      ) : (
        <div className="space-y-5">
          {INSTRUCTION_KINDS.filter((k) => grouped.has(k)).map((kind) => (
            <div key={kind}>
              <h2 className="mb-1 text-sm font-semibold">
                {titleCase(kind)}
                {scope === "org" && personalised.has(kind) && (
                  <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-normal text-amber-800">overridden by your personal doc</span>
                )}
              </h2>
              <p className="mb-2 text-xs text-gray-500">{KIND_HELP[kind]}</p>
              <div className="space-y-2">
                {grouped.get(kind)!.map((d) => (
                  <div key={d.id} className={"card " + (d.isActive ? "" : "opacity-60")}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">
                          {d.title} <span className="ml-1 rounded bg-gray-100 px-1.5 text-xs text-gray-600">v{d.version}</span>
                          {!d.isActive && <span className="ml-1 text-xs text-gray-500">inactive</span>}
                        </div>
                        <div className="text-xs text-gray-500">{formatDate(d.createdAt)}</div>
                      </div>
                      {canEditScope && (
                        <div className="flex gap-1">
                          <button className="btn-ghost btn-sm" onClick={() => setEditing(d)}>
                            Edit (new version)
                          </button>
                          <button className="btn-ghost btn-sm" disabled={toggle.isPending} onClick={() => toggle.mutate(d)}>
                            {d.isActive ? "Deactivate" : "Activate"}
                          </button>
                          <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(d)}>
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-gray-500">Show content</summary>
                      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 font-sans text-xs text-gray-800">{d.content}</pre>
                    </details>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <InstructionForm
          scope={scope}
          initial={editing === "new" ? { kind: "tone", title: "", content: "", isActive: true } : { kind: editing.kind, title: editing.title, content: editing.content, isActive: true }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
      {uploadOpen && (
        <UploadForm
          scope={scope}
          onClose={() => setUploadOpen(false)}
          onSaved={() => {
            setUploadOpen(false);
            invalidate();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete instruction"
        message={`Delete "${deleting?.title}" (v${deleting?.version})? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function InstructionForm({
  scope,
  initial,
  onClose,
  onSaved,
}: {
  scope: InstructionScope;
  initial: { kind: InstructionKind; title: string; content: string; isActive: boolean };
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api.post("/api/instructions", body),
    onSuccess: () => {
      toast.success("Instruction saved");
      onSaved();
    },
    onError: (e) => toast.error(e, "Save failed"),
  });
  const submit = () => {
    const parsed = InstructionSchema.safeParse(form);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(`${i.path.join(".")}: ${i.message}`);
      return;
    }
    save.mutate({ ...parsed.data, scope });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={scope === "org" ? "Organisation instruction document" : "My instruction document"}
      wide
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={save.isPending} onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[12rem_1fr]">
        <Field label="Kind">
          <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as InstructionKind })}>
            {INSTRUCTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {titleCase(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" hint="Saving with an existing kind + title creates a new version.">
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Content (markdown allowed)">
            <textarea className="input font-mono text-xs" rows={16} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
          </Field>
        </div>
      </div>
      {error && <div className="mt-3"><ErrorBox message={error} /></div>}
    </Modal>
  );
}

function UploadForm({ scope, onClose, onSaved }: { scope: InstructionScope; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<InstructionKind>("tone");
  const [title, setTitle] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: () => {
      const f = ref.current?.files?.[0];
      if (!f) throw new Error("Choose a file");
      const fd = new FormData();
      fd.append("file", f);
      fd.append("kind", kind);
      fd.append("title", title || f.name);
      fd.append("scope", scope);
      return api.upload("/api/instructions/upload", fd);
    },
    onSuccess: () => {
      toast.success("Uploaded");
      onSaved();
    },
    onError: (e) => toast.error(e, "Upload failed"),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Upload instruction file"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={upload.isPending} onClick={() => upload.mutate()}>
            Upload
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Kind">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as InstructionKind)}>
            {INSTRUCTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {titleCase(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" hint="Defaults to the file name">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="File (.md, .txt, .docx)">
          <input ref={ref} type="file" accept=".md,.txt,.docx,text/plain,text/markdown" />
        </Field>
      </div>
    </Modal>
  );
}
