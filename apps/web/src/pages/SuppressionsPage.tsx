import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SUPPRESSION_REASONS, type Paginated, type SuppressionDto, type SuppressionReason } from "@mailapp/shared";
import { api } from "../lib/api";
import { formatDate, titleCase } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { ConfirmDialog, EmptyState, ErrorBox, Field, Modal, PageHeader, Pagination, Spinner } from "../components/ui";

export function SuppressionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { canWrite } = useAuth();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<SuppressionDto | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const q = useQuery({
    queryKey: ["suppressions", debounced, page],
    queryFn: () => api.get<Paginated<SuppressionDto>>("/api/suppressions", { search: debounced || undefined, page, pageSize: 50 }),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["suppressions"] });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/suppressions/${id}`),
    onSuccess: () => {
      toast.success("Removed from suppression list");
      setDeleting(null);
      invalidate();
    },
    onError: (e) => toast.error(e),
  });
  const importMut = useMutation({
    mutationFn: (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      return api.upload<{ imported: number }>("/api/suppressions/import", fd);
    },
    onSuccess: (r) => {
      toast.success(`Imported ${r.imported} addresses`);
      invalidate();
    },
    onError: (e) => toast.error(e, "Import failed"),
  });

  return (
    <div>
      <PageHeader
        title="Suppression list"
        subtitle="Addresses that will never be emailed: hard bounces, complaints, unsubscribes and manual entries"
        actions={
          <>
            <input className="input w-64" placeholder="Search email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
            <a className="btn-secondary" href="/api/suppressions/export" title="Download the whole list as an Excel file you can share or re-import">
              Export xlsx
            </a>
            {canWrite && (
              <>
                <input ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importMut.mutate(f); e.target.value = ""; }} />
                <button className="btn-secondary" disabled={importMut.isPending} onClick={() => fileRef.current?.click()}>
                  Import
                </button>
                <button className="btn-primary" onClick={() => setAddOpen(true)}>
                  Add address
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
        <EmptyState title="No suppressed addresses" />
      ) : (
        <div className="card p-0">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Reason</th>
                <th>Source</th>
                <th>Note</th>
                <th>Added</th>
                {canWrite && <th></th>}
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((s) => (
                <tr key={s.id}>
                  <td className="font-mono text-xs">{s.email}</td>
                  <td className="text-xs">{titleCase(s.reason)}</td>
                  <td className="text-xs text-gray-500">{s.source ?? "—"}</td>
                  <td className="text-xs text-gray-600">{s.note ?? ""}</td>
                  <td className="text-xs text-gray-500">{formatDate(s.createdAt)}</td>
                  {canWrite && (
                    <td>
                      <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(s)}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3">
            <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
          </div>
        </div>
      )}
      {addOpen && (
        <AddForm
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            invalidate();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Remove from suppression list"
        message={`${deleting?.email} will become eligible for outreach again. Only do this if the suppression was a mistake.`}
        confirmLabel="Remove"
        danger
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function AddForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<SuppressionReason>("manual");
  const [note, setNote] = useState("");
  const add = useMutation({
    mutationFn: () => api.post("/api/suppressions", { email, reason, note: note || undefined }),
    onSuccess: () => {
      toast.success("Address suppressed");
      onSaved();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Add suppressed address"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={add.isPending || !email} onClick={() => add.mutate()}>
            Add
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Email">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Reason">
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value as SuppressionReason)}>
            {SUPPRESSION_REASONS.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
