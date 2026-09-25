import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ServiceSchema, type ServiceDto, type ServiceInput } from "@mailapp/shared";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { ChipsInput } from "../components/ChipsInput";
import { ConfirmDialog, EmptyState, ErrorBox, Field, Modal, PageHeader, Spinner } from "../components/ui";

const EMPTY: ServiceInput = {
  name: "",
  description: "",
  targetAudience: "",
  valueProps: [],
  proofPoints: [],
  url: "",
  tags: [],
  isActive: true,
};

export function ServicesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { canWrite } = useAuth();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<ServiceDto | "new" | null>(null);
  const [deleting, setDeleting] = useState<ServiceDto | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const q = useQuery({
    queryKey: ["services", includeInactive],
    queryFn: () => api.get<{ items: ServiceDto[] }>("/api/services", { includeInactive: includeInactive || undefined }),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["services"] });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/services/${id}`),
    onSuccess: () => {
      toast.success("Service deactivated");
      setDeleting(null);
      invalidate();
    },
    onError: (e) => toast.error(e),
  });
  const importMut = useMutation({
    mutationFn: (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      return api.upload<{ imported: number; updated: number; errors: Array<{ row: number; reason: string }> }>("/api/services/import", fd);
    },
    onSuccess: (r) => {
      toast.success(`Imported ${r.imported}, updated ${r.updated}${r.errors.length ? `, ${r.errors.length} errors` : ""}`);
      invalidate();
    },
    onError: (e) => toast.error(e, "Import failed"),
  });

  return (
    <div>
      <PageHeader
        title="Services"
        subtitle="The catalogue the LLM picks from when pitching a lead"
        actions={
          <>
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
            </label>
            <Link to="/services/landing" className="btn-secondary" title="The page recipients see when they click the link at the bottom of an email">
              Manage link page
            </Link>
            {canWrite && (
              <>
                <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importMut.mutate(f); e.target.value = ""; }} />
                <button className="btn-secondary" disabled={importMut.isPending} onClick={() => fileRef.current?.click()}>
                  {importMut.isPending ? "Importing…" : "Import xlsx"}
                </button>
                <button className="btn-primary" onClick={() => setEditing("new")}>
                  Add service
                </button>
              </>
            )}
          </>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox message={(q.error as Error).message} />
      ) : !q.data?.items.length ? (
        <EmptyState title="No services" hint="Add services manually or import a sheet with columns: name, description, target audience, value props, proof points, url, tags." />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Audience</th>
                <th>Tags</th>
                <th>Active</th>
                {canWrite && <th></th>}
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((s) => (
                <tr key={s.id} className={s.isActive ? "" : "opacity-60"}>
                  <td className="font-medium">
                    {s.name}
                    {s.url && (
                      <a className="ml-1 text-xs text-brand-700 hover:underline" href={s.url} target="_blank" rel="noreferrer">
                        link
                      </a>
                    )}
                  </td>
                  <td className="max-w-md text-xs text-gray-700">{s.description}</td>
                  <td className="max-w-xs text-xs text-gray-600">{s.targetAudience}</td>
                  <td className="text-xs">{s.tags.join(", ")}</td>
                  <td>{s.isActive ? "yes" : "no"}</td>
                  {canWrite && (
                    <td className="whitespace-nowrap">
                      <button className="btn-ghost btn-sm" onClick={() => setEditing(s)}>
                        Edit
                      </button>
                      {s.isActive && (
                        <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(s)}>
                          Deactivate
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ServiceForm
          initial={editing === "new" ? EMPTY : editing}
          id={editing === "new" ? null : editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Deactivate service"
        message={`"${deleting?.name}" will no longer be offered to the LLM. Existing drafts are unaffected.`}
        confirmLabel="Deactivate"
        danger
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function ServiceForm({ initial, id, onClose, onSaved }: { initial: ServiceInput; id: string | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<ServiceInput>({ ...initial });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: ServiceInput) => (id ? api.patch(`/api/services/${id}`, body) : api.post("/api/services", body)),
    onSuccess: () => {
      toast.success("Service saved");
      onSaved();
    },
    onError: (e) => toast.error(e, "Save failed"),
  });
  const set = <K extends keyof ServiceInput>(k: K, v: ServiceInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    setError(null);
    const parsed = ServiceSchema.safeParse(form);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(`${i.path.join(".")}: ${i.message}`);
      return;
    }
    save.mutate(parsed.data);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={id ? "Edit service" : "Add service"}
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name">
          <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="URL">
          <input className="input" value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://" />
        </Field>
        <div className="md:col-span-2">
          <Field label="Description" hint="What it is, how it is delivered, typical outcomes.">
            <textarea className="input" rows={4} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Target audience">
            <textarea className="input" rows={2} value={form.targetAudience} onChange={(e) => set("targetAudience", e.target.value)} />
          </Field>
        </div>
        <Field label="Value propositions">
          <ChipsInput value={form.valueProps} onChange={(v) => set("valueProps", v)} />
        </Field>
        <Field label="Proof points / case studies">
          <ChipsInput value={form.proofPoints} onChange={(v) => set("proofPoints", v)} />
        </Field>
        <Field label="Tags">
          <ChipsInput value={form.tags} onChange={(v) => set("tags", v)} />
        </Field>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} /> Active
          </label>
        </div>
      </div>
      {error && <div className="mt-3"><ErrorBox message={error} /></div>}
    </Modal>
  );
}
