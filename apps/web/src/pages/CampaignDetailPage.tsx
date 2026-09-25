import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CAMPAIGN_ACCESS_LEVELS,
  LEAD_STATUSES,
  UpdateCampaignSchema,
  type ApprovalMode,
  type CampaignAccessDto,
  type CampaignAccessLevel,
  type CampaignCounts,
  type CampaignDto,
  type LeadDto,
  type Paginated,
  type SequenceStep,
  type ServiceDto,
  type TimeseriesPoint,
} from "@mailapp/shared";
import { api, errorMessage } from "../lib/api";
import { formatDate, fullName, relativeTime } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { StatusBadge } from "../components/StatusBadge";
import { ReviewQueue } from "../components/ReviewQueue";
import { SequenceEditor, validateSequence } from "../components/SequenceEditor";
import { TimeseriesChart } from "../components/charts";
import { ChipsInput } from "../components/ChipsInput";
import { Banner, ConfirmDialog, EmptyState, ErrorBox, Field, PageHeader, Pagination, Spinner, Tabs } from "../components/ui";

type Tab = "overview" | "leads" | "review" | "settings" | "stats" | "access";

const FUNNEL: Array<{ key: keyof CampaignCounts; label: string }> = [
  { key: "total", label: "Leads" },
  { key: "sent", label: "Sent" },
  { key: "delivered", label: "Delivered" },
  { key: "opened", label: "Opened" },
  { key: "clicked", label: "Clicked" },
  { key: "replied", label: "Replied" },
];

const ACCESS_HELP: Record<CampaignAccessLevel, string> = {
  view: "Can open the campaign, leads and stats. No changes.",
  edit: "View plus review drafts (approve / reject / regenerate) and lead actions.",
  full: "Everything the owner can do: start, pause, archive, edit while draft.",
};

export function CampaignDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const setTab = (t: Tab) => setParams({ tab: t });
  const qc = useQueryClient();
  const toast = useToast();
  const { isAdmin } = useAuth();

  const q = useQuery({
    queryKey: ["campaigns", id],
    queryFn: () => api.get<{ campaign: CampaignDto }>(`/api/campaigns/${id}`),
    refetchInterval: 20_000,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["campaigns"] });
    qc.invalidateQueries({ queryKey: ["leads"] });
    qc.invalidateQueries({ queryKey: ["emails"] });
  };
  const action = useMutation({
    mutationFn: (a: "start" | "pause" | "resume" | "archive" | "approve-all") => api.post<unknown>(`/api/campaigns/${id}/${a}`),
    onSuccess: (r, a) => {
      const enq = (r as { enqueued?: number; approved?: number }) ?? {};
      toast.success(
        a === "start"
          ? `Campaign started (${enq.enqueued ?? 0} leads queued)`
          : a === "approve-all"
            ? `Approved ${enq.approved ?? 0} drafts`
            : `Campaign ${a}d`,
      );
      invalidate();
    },
    onError: (e) => toast.error(e),
  });
  const [confirm, setConfirm] = useState<null | "archive" | "approve-all" | "start">(null);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={(q.error as Error).message} />;
  const c = q.data!.campaign;
  const canControl = c.myAccess === "full";
  const canReview = c.myAccess === "full" || c.myAccess === "edit";
  const editable = canControl && c.status === "draft";

  return (
    <div>
      <PageHeader
        title={c.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} /> {c.approvalMode} approval · {c.counts.total} leads · created {formatDate(c.createdAt, false)}
            {c.createdByName && <span>· owner {c.createdByName}</span>}
            {c.myAccess !== "full" && <span className="rounded bg-gray-100 px-1.5 text-xs text-gray-600">{c.myAccess} access</span>}
          </span>
        }
        actions={
          <>
            {editable && (
              <button className="btn-secondary" onClick={() => setTab("settings")} title="Draft campaigns can be edited until they are started">
                Edit
              </button>
            )}
            {canControl && c.status === "draft" && (
              <button className="btn-primary" disabled={action.isPending} onClick={() => setConfirm("start")}>
                Start campaign
              </button>
            )}
            {canControl && c.status === "active" && (
              <button className="btn-secondary" disabled={action.isPending} onClick={() => action.mutate("pause")}>
                Pause
              </button>
            )}
            {canControl && c.status === "paused" && (
              <button className="btn-primary" disabled={action.isPending} onClick={() => action.mutate("resume")}>
                Resume
              </button>
            )}
            {canReview && c.counts.pendingReview > 0 && (
              <button className="btn-secondary" disabled={action.isPending} onClick={() => setConfirm("approve-all")}>
                Approve all ({c.counts.pendingReview})
              </button>
            )}
            <a className="btn-secondary" href={`/api/campaigns/${id}/export`}>
              Export status xlsx
            </a>
            {canControl && c.status !== "archived" && (
              <button className="btn-ghost text-red-700" disabled={action.isPending} onClick={() => setConfirm("archive")}>
                Archive
              </button>
            )}
          </>
        }
      />

      <Tabs<Tab>
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "leads", label: "Leads", count: c.counts.total },
          { key: "review", label: "Review queue", count: c.counts.pendingReview },
          { key: "settings", label: editable ? "Edit campaign" : "Sequence & settings" },
          { key: "stats", label: "Stats" },
          ...(isAdmin ? [{ key: "access" as Tab, label: "Access" }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "overview" && <Overview c={c} />}
      {tab === "leads" && <LeadsTab campaignId={id} />}
      {tab === "review" && <ReviewQueue campaignId={id} />}
      {tab === "settings" && <SettingsTab c={c} editable={editable} onSaved={invalidate} />}
      {tab === "stats" && <StatsTab campaignId={id} />}
      {tab === "access" && isAdmin && <AccessTab c={c} />}

      <ConfirmDialog
        open={confirm === "archive"}
        title="Archive campaign"
        message="Archiving stops all scheduled follow-ups for this campaign. Leads and history are kept."
        confirmLabel="Archive"
        danger
        busy={action.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          action.mutate("archive");
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "approve-all"}
        title="Approve all pending drafts"
        message={`This approves ${c.counts.pendingReview} draft(s) and queues them for sending without individual review.`}
        confirmLabel="Approve all"
        busy={action.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          action.mutate("approve-all");
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "start"}
        title="Start campaign"
        message={
          <>
            {c.approvalMode === "auto"
              ? "Auto-send mode: research and drafting will begin now and validated drafts will be SENT without manual review."
              : "Research and drafting will begin now. Drafts will wait in the review queue."}
            <div className="mt-2 text-xs text-gray-500">Once started, the campaign settings (sequence, sender, guidance) can no longer be edited.</div>
          </>
        }
        confirmLabel="Start"
        busy={action.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          action.mutate("start");
          setConfirm(null);
        }}
      />
    </div>
  );
}

function Overview({ c }: { c: CampaignDto }) {
  const max = Math.max(1, c.counts.total);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="card lg:col-span-2">
        <h2 className="mb-3 text-sm font-semibold">Funnel</h2>
        <div className="space-y-2">
          {FUNNEL.map((f) => {
            const v = c.counts[f.key];
            return (
              <div key={f.key} className="grid grid-cols-[6rem_1fr_3rem] items-center gap-2 text-sm">
                <span className="text-gray-600">{f.label}</span>
                <div className="h-3 rounded bg-brand-100">
                  <div className="h-3 rounded bg-brand-500" style={{ width: `${(100 * v) / max}%` }} />
                </div>
                <span className="text-right tabular-nums">{v}</span>
              </div>
            );
          })}
        </div>
        <h2 className="mb-2 mt-5 text-sm font-semibold">Pipeline</h2>
        <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          {(
            [
              ["pending", "Pending"],
              ["researching", "Researching"],
              ["drafting", "Drafting"],
              ["pendingReview", "Pending review"],
              ["approved", "Approved"],
              ["bounced", "Bounced"],
              ["complained", "Complaints"],
              ["unsubscribed", "Unsubscribed"],
              ["failed", "Failed"],
              ["other", "Other"],
            ] as Array<[keyof CampaignCounts, string]>
          ).map(([k, label]) => (
            <div key={k} className="rounded border border-gray-200 px-3 py-2">
              <div className="text-xs text-gray-500">{label}</div>
              <div className="text-lg font-semibold tabular-nums">{c.counts[k]}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="card space-y-3 text-sm">
        <h2 className="text-sm font-semibold">Import</h2>
        {c.importSummary ? (
          <ul className="space-y-1 text-gray-700">
            <li>Rows in sheet: {c.importSummary.totalRows}</li>
            <li>Imported: {c.importSummary.imported}</li>
            <li>Duplicates in sheet: {c.importSummary.duplicatesInSheet}</li>
            <li>Invalid emails: {c.importSummary.invalidEmails}</li>
            <li>Suppressed: {c.importSummary.suppressed}</li>
            {c.importSummary.unmappedColumns.length > 0 && <li>Extra columns: {c.importSummary.unmappedColumns.join(", ")}</li>}
            {c.importSummary.sampleErrors.length > 0 && (
              <li>
                <details>
                  <summary className="cursor-pointer text-xs text-gray-500">Sample errors</summary>
                  <ul className="mt-1 list-disc pl-4 text-xs">
                    {c.importSummary.sampleErrors.map((e, i) => (
                      <li key={i}>
                        Row {e.row}: {e.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            )}
          </ul>
        ) : (
          <p className="text-gray-500">No import summary.</p>
        )}
        {c.description && (
          <>
            <h2 className="text-sm font-semibold">Description</h2>
            <p className="whitespace-pre-wrap text-gray-700">{c.description}</p>
          </>
        )}
        <h2 className="text-sm font-semibold">Timeline</h2>
        <ul className="text-gray-700">
          <li>Started: {formatDate(c.startedAt)}</li>
          <li>Completed: {formatDate(c.completedAt)}</li>
          <li>Updated: {relativeTime(c.updatedAt)}</li>
        </ul>
      </div>
    </div>
  );
}

function LeadsTab({ campaignId }: { campaignId: string }) {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const q = useQuery({
    queryKey: ["leads", campaignId, status, debounced, page],
    queryFn: () =>
      api.get<Paginated<LeadDto>>(`/api/campaigns/${campaignId}/leads`, { status: status || undefined, search: debounced || undefined, page, pageSize: 50 }),
    refetchInterval: 20_000,
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input className="input w-64" placeholder="Search name, email, company" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <select className="input w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Lead status filter">
          <option value="">All statuses</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox message={(q.error as Error).message} />
      ) : !q.data?.items.length ? (
        <EmptyState title="No leads match" />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Email</th>
                <th>Company</th>
                <th>Title</th>
                <th>Status</th>
                <th>Step</th>
                <th>Scheduled send</th>
                <th>Next follow-up</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((l) => (
                <tr key={l.id}>
                  <td className="text-xs text-gray-500">{l.rowNumber}</td>
                  <td>
                    <Link to={`/leads/${l.id}`} className="font-medium text-brand-700 hover:underline">
                      {fullName(l.firstName, l.lastName)}
                    </Link>
                  </td>
                  <td className="text-xs">{l.email}</td>
                  <td>{l.company ?? "—"}</td>
                  <td className="text-xs text-gray-600">{l.jobTitle ?? "—"}</td>
                  <td>
                    <StatusBadge status={l.status} />
                    {l.lastError && <div className="max-w-[16rem] truncate text-xs text-red-600" title={l.lastError}>{l.lastError}</div>}
                  </td>
                  <td className="tabular-nums">{l.currentStep}</td>
                  <td className="text-xs">
                    {l.nextSendAt ? (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-800" title="When the approved/queued email is expected to go out">
                        {formatDate(l.nextSendAt)}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="text-xs text-gray-500">{formatDate(l.nextActionAt)}</td>
                  <td className="text-xs text-gray-500">{relativeTime(l.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3">
            <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsTab({ c, editable, onSaved }: { c: CampaignDto; editable: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(c.name);
  const [description, setDescription] = useState(c.description);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(c.approvalMode);
  const [sequence, setSequence] = useState<SequenceStep[]>(c.sequence);
  const [serviceIds, setServiceIds] = useState<string[]>(c.serviceIds);
  const [fromEmail, setFromEmail] = useState(c.fromEmail ?? "");
  const [fromName, setFromName] = useState(c.fromName ?? "");
  const [replyTo, setReplyTo] = useState(c.replyTo ?? "");
  const [extraGuidance, setExtraGuidance] = useState(c.extraGuidance);
  const [maxWords, setMaxWords] = useState(c.hardRulesOverride?.maxWords ? String(c.hardRulesOverride.maxWords) : "");
  const [banned, setBanned] = useState<string[]>(c.hardRulesOverride?.bannedPhrases ?? []);
  const [error, setError] = useState<string | null>(null);
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.get<{ items: ServiceDto[] }>("/api/services") });
  const save = useMutation({
    mutationFn: (body: unknown) => api.patch<{ campaign: CampaignDto }>(`/api/campaigns/${c.id}`, body),
    onSuccess: () => {
      toast.success("Campaign updated");
      onSaved();
    },
    onError: (e) => toast.error(e, "Save failed"),
  });
  const disabled = !editable;
  const submit = () => {
    setError(null);
    const override: Record<string, unknown> = {};
    if (maxWords.trim()) override.maxWords = Number(maxWords);
    if (banned.length) override.bannedPhrases = banned;
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
      hardRulesOverride: Object.keys(override).length ? override : undefined,
    };
    const parsed = UpdateCampaignSchema.safeParse(raw);
    if (!parsed.success) {
      setError(errorMessage(new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))));
      return;
    }
    save.mutate(parsed.data);
  };
  return (
    <div className="space-y-4">
      {disabled && (
        <Banner kind="info">
          {c.status === "draft"
            ? "You have read-only access to this campaign."
            : "Settings are locked because the campaign has been started. Pause or archive it and create a new campaign to change the sequence or sender."}
        </Banner>
      )}
      <div className="card space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name">
            <input className="input" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Approval mode">
            <select className="input" value={approvalMode} disabled={disabled} onChange={(e) => setApprovalMode(e.target.value as ApprovalMode)}>
              <option value="manual">Manual review</option>
              <option value="auto">Auto-send</option>
            </select>
          </Field>
        </div>
        <Field label="Description">
          <textarea className="input" rows={2} value={description} disabled={disabled} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold">Sequence</h2>
        <SequenceEditor value={sequence} onChange={setSequence} disabled={disabled} />
      </div>
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold">Services</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {(services.data?.items ?? []).map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={serviceIds.includes(s.id)}
                onChange={(e) => setServiceIds(e.target.checked ? [...serviceIds, s.id] : serviceIds.filter((x) => x !== s.id))}
              />
              {s.name}
              {!s.isActive && <span className="text-xs text-gray-400">(inactive)</span>}
            </label>
          ))}
        </div>
      </div>
      <div className="card space-y-4">
        <h2 className="text-sm font-semibold">Sender & guidance</h2>
        <p className="text-xs text-gray-500">Blank sender fields use the campaign owner's profile, then the organisation settings.</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="From email">
            <input className="input" type="email" value={fromEmail} disabled={disabled} onChange={(e) => setFromEmail(e.target.value)} />
          </Field>
          <Field label="From name">
            <input className="input" value={fromName} disabled={disabled} onChange={(e) => setFromName(e.target.value)} />
          </Field>
          <Field label="Reply-to">
            <input className="input" type="email" value={replyTo} disabled={disabled} onChange={(e) => setReplyTo(e.target.value)} />
          </Field>
        </div>
        <Field label="Extra guidance">
          <textarea className="input" rows={3} value={extraGuidance} disabled={disabled} onChange={(e) => setExtraGuidance(e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[10rem_1fr]">
          <Field label="Max words override">
            <input className="input" type="number" value={maxWords} disabled={disabled} onChange={(e) => setMaxWords(e.target.value)} />
          </Field>
          <Field label="Banned phrases (campaign)">
            <ChipsInput value={banned} onChange={setBanned} disabled={disabled} />
          </Field>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      {!disabled && (
        <div className="flex justify-end">
          <button className="btn-primary" disabled={save.isPending || validateSequence(sequence).length > 0} onClick={submit}>
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </div>
  );
}

function StatsTab({ campaignId }: { campaignId: string }) {
  const q = useQuery({
    queryKey: ["campaigns", campaignId, "stats"],
    queryFn: () => api.get<{ counts: CampaignCounts; timeseries: TimeseriesPoint[] }>(`/api/campaigns/${campaignId}/stats`),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={(q.error as Error).message} />;
  return (
    <div className="card">
      <h2 className="mb-2 text-sm font-semibold">Daily activity</h2>
      <TimeseriesChart points={q.data?.timeseries ?? []} />
    </div>
  );
}

interface DirectoryUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

/** Admin: grant other users view / edit / full access to this campaign. */
function AccessTab({ c }: { c: CampaignDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [userId, setUserId] = useState("");
  const [level, setLevel] = useState<CampaignAccessLevel>("view");
  const grants = useQuery({ queryKey: ["campaigns", c.id, "access"], queryFn: () => api.get<{ items: CampaignAccessDto[] }>(`/api/campaigns/${c.id}/access`) });
  const directory = useQuery({ queryKey: ["users", "directory"], queryFn: () => api.get<{ items: DirectoryUser[] }>("/api/users/directory") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["campaigns", c.id, "access"] });
  const grant = useMutation({
    mutationFn: () => api.put(`/api/campaigns/${c.id}/access`, { userId, level }),
    onSuccess: () => {
      toast.success("Access updated");
      setUserId("");
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  const revoke = useMutation({
    mutationFn: (uid: string) => api.delete(`/api/campaigns/${c.id}/access/${uid}`),
    onSuccess: () => {
      toast.success("Access revoked");
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  const granted = new Set((grants.data?.items ?? []).map((g) => g.userId));
  const candidates = (directory.data?.items ?? []).filter((u) => u.id !== c.createdBy && u.role !== "admin");

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold">Who can work on this campaign</h2>
        <p className="text-sm text-gray-600">
          The owner {c.createdByName ? <strong>{c.createdByName}</strong> : "(none)"} and every administrator have full access. Other
          operators and viewers only see this campaign if you grant them access here.
        </p>
        <ul className="grid grid-cols-1 gap-2 text-xs text-gray-600 md:grid-cols-3">
          {CAMPAIGN_ACCESS_LEVELS.map((l) => (
            <li key={l} className="rounded border border-gray-200 p-2">
              <span className="font-semibold text-gray-800">{l}</span> · {ACCESS_HELP[l]}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="User">
            <select className="input w-64" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose a user…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email}) · {u.role}
                  {granted.has(u.id) ? " · already granted" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Level">
            <select className="input w-32" value={level} onChange={(e) => setLevel(e.target.value as CampaignAccessLevel)}>
              {CAMPAIGN_ACCESS_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn-primary" disabled={!userId || grant.isPending} onClick={() => grant.mutate()}>
            {granted.has(userId) ? "Change level" : "Grant access"}
          </button>
        </div>
      </div>
      {grants.isLoading ? (
        <Spinner />
      ) : !grants.data?.items.length ? (
        <EmptyState title="No one else has access yet" />
      ) : (
        <div className="card p-0">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Level</th>
                <th>Granted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {grants.data.items.map((g) => (
                <tr key={g.userId}>
                  <td>
                    <div className="font-medium">{g.userName}</div>
                    <div className="text-xs text-gray-500">{g.userEmail}</div>
                  </td>
                  <td>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{g.level}</span>
                  </td>
                  <td className="text-xs text-gray-500">{formatDate(g.createdAt)}</td>
                  <td className="text-right">
                    <button className="btn-ghost btn-sm text-red-700" disabled={revoke.isPending} onClick={() => revoke.mutate(g.userId)}>
                      Revoke
                    </button>
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
