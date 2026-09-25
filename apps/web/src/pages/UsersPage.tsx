import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreateUserSchema,
  DASHBOARD_SCOPES,
  USER_ROLES,
  UpdateUserSchema,
  type DashboardScope,
  type UserDto,
  type UserRole,
  type UserStatsDto,
} from "@mailapp/shared";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { ConfirmDialog, EmptyState, ErrorBox, Field, Modal, PageHeader, Spinner } from "../components/ui";

export function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [stopping, setStopping] = useState<UserDto | null>(null);
  const [deleting, setDeleting] = useState<UserDto | null>(null);
  const q = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ items: UserDto[] }>("/api/users") });
  const stats = useQuery({
    queryKey: ["users", "stats"],
    queryFn: () => api.get<{ items: UserStatsDto[] }>("/api/users/stats"),
    refetchInterval: 30_000,
  });
  const statsById = new Map((stats.data?.items ?? []).map((s) => [s.userId, s]));
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["users"] });
    qc.invalidateQueries({ queryKey: ["campaigns"] });
  };
  const toggleActive = useMutation({
    mutationFn: (u: UserDto) => api.patch(`/api/users/${u.id}`, { isActive: !u.isActive }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e),
  });
  const stopSending = useMutation({
    mutationFn: (u: UserDto) => api.post<{ pausedCampaigns: number }>(`/api/users/${u.id}/stop-sending`),
    onSuccess: (r) => {
      toast.success(`Paused ${r.pausedCampaigns} active campaign(s)`);
      setStopping(null);
      invalidate();
    },
    onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: (u: UserDto) => api.delete<{ pausedCampaigns: number }>(`/api/users/${u.id}`),
    onSuccess: () => {
      toast.success("User deleted");
      setDeleting(null);
      invalidate();
    },
    onError: (e) => toast.error(e, "Delete failed"),
  });

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Who sends what: campaigns owned, emails sent and queued per user"
        actions={<button className="btn-primary" onClick={() => setCreating(true)}>Add user</button>}
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox message={(q.error as Error).message} />
      ) : !q.data?.items.length ? (
        <EmptyState title="No users" />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Sends as</th>
                <th className="text-right">Campaigns</th>
                <th className="text-right">Active</th>
                <th className="text-right">Sent today</th>
                <th className="text-right">Sent 7d</th>
                <th className="text-right">Sent total</th>
                <th className="text-right">Queued</th>
                <th>Last sent</th>
                <th>Last login</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((u) => {
                const s = statsById.get(u.id);
                return (
                  <tr key={u.id} className={u.isActive ? "" : "opacity-60"}>
                    <td>
                      <div className="font-medium">
                        {u.name}
                        {u.id === me?.id && <span className="ml-1 text-xs text-gray-400">(you)</span>}
                        {!u.isActive && <span className="ml-1 rounded bg-gray-100 px-1 text-xs text-gray-600">inactive</span>}
                      </div>
                      <div className="text-xs text-gray-500">{u.email}</div>
                    </td>
                    <td>
                      {u.role}
                      {u.dashboardScope === "all" && u.role !== "admin" && <div className="text-xs text-gray-500">sees all dashboards</div>}
                    </td>
                    <td className="text-xs">
                      {u.fromEmail ? (
                        <>
                          {u.fromName && <div>{u.fromName}</div>}
                          <div className="text-gray-600">{u.fromEmail}</div>
                        </>
                      ) : (
                        <span className="text-gray-400">org default</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{s?.campaigns ?? 0}</td>
                    <td className={"text-right tabular-nums " + (s?.activeCampaigns ? "font-medium text-blue-700" : "")}>{s?.activeCampaigns ?? 0}</td>
                    <td className="text-right tabular-nums">{s?.sentToday ?? 0}</td>
                    <td className="text-right tabular-nums">{s?.sentLast7Days ?? 0}</td>
                    <td className="text-right tabular-nums">{s?.sentTotal ?? 0}</td>
                    <td className={"text-right tabular-nums " + (s?.pendingSend ? "text-amber-700" : "")}>{s?.pendingSend ?? 0}</td>
                    <td className="text-xs text-gray-500">{formatDate(s?.lastSentAt ?? null)}</td>
                    <td className="text-xs text-gray-500">{formatDate(u.lastLoginAt)}</td>
                    <td className="whitespace-nowrap">
                      <button className="btn-ghost btn-sm" onClick={() => setEditing(u)}>
                        Edit
                      </button>
                      <button className="btn-ghost btn-sm" disabled={toggleActive.isPending || u.id === me?.id} onClick={() => toggleActive.mutate(u)}>
                        {u.isActive ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        className="btn-ghost btn-sm text-amber-700"
                        disabled={!s?.activeCampaigns}
                        title="Pause every active campaign this user owns"
                        onClick={() => setStopping(u)}
                      >
                        Stop sending
                      </button>
                      <button className="btn-ghost btn-sm text-red-700" disabled={u.id === me?.id} onClick={() => setDeleting(u)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <UserForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            invalidate();
          }}
        />
      )}
      {editing && (
        <UserForm
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
      <ConfirmDialog
        open={!!stopping}
        title="Stop this user's sending"
        message={
          <>
            Every <strong>active</strong> campaign owned by {stopping?.name} will be paused. Approved emails stay approved but nothing
            goes out until a campaign is resumed. Campaigns other users share with them are not affected.
          </>
        }
        confirmLabel="Pause their campaigns"
        danger
        busy={stopSending.isPending}
        onCancel={() => setStopping(null)}
        onConfirm={() => stopping && stopSending.mutate(stopping)}
      />
      <ConfirmDialog
        open={!!deleting}
        title="Delete user"
        message={
          <>
            Delete <strong>{deleting?.email}</strong>? Their active campaigns are paused first. Campaigns, sent emails and audit history are
            kept (without an owner; grant another user access to take them over). Their personal instruction documents and access grants
            are removed. This cannot be undone.
          </>
        }
        confirmLabel="Delete user"
        danger
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function UserForm({ user, onClose, onSaved }: { user?: UserDto; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { user: me } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<UserRole>(user?.role ?? "operator");
  const [dashboardScope, setDashboardScope] = useState<DashboardScope>(user?.dashboardScope ?? "own");
  const [password, setPassword] = useState("");
  const [fromEmail, setFromEmail] = useState(user?.fromEmail ?? "");
  const [fromName, setFromName] = useState(user?.fromName ?? "");
  const [replyTo, setReplyTo] = useState(user?.replyTo ?? "");
  const [postalAddress, setPostalAddress] = useState(user?.postalAddress ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => (user ? api.patch(`/api/users/${user.id}`, body) : api.post("/api/users", body)),
    onSuccess: () => {
      toast.success("User saved");
      onSaved();
    },
    onError: (e) => toast.error(e, "Save failed"),
  });
  const isSelf = !!user && user.id === me?.id;
  const submit = () => {
    setError(null);
    const sender = { fromEmail, fromName, replyTo, postalAddress };
    const parsed = user
      ? UpdateUserSchema.safeParse({ name, ...(isSelf ? {} : { role, dashboardScope }), password: password || undefined, ...sender })
      : CreateUserSchema.safeParse({ name, email, role, dashboardScope, password, ...sender });
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
      title={user ? "Edit user" : "Add user"}
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
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Login email">
            <input className="input" type="email" value={email} disabled={!!user} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Role" hint="Operators only see campaigns they created or were granted; admins see everything">
            <select className="input" value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value as UserRole)}>
              {USER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Dashboard scope" hint="'all' lets a non-admin see every campaign's numbers on the dashboard (read-only)">
            <select className="input" value={dashboardScope} disabled={isSelf || role === "admin"} onChange={(e) => setDashboardScope(e.target.value as DashboardScope)}>
              {DASHBOARD_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {s === "own" ? "own & granted campaigns" : "all campaigns"}
                </option>
              ))}
            </select>
          </Field>
          <Field label={user ? "New password (leave blank to keep)" : "Password"} hint="At least 12 characters">
            <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase text-gray-500">Sender identity</h3>
          <p className="mb-2 text-xs text-gray-500">
            Used on campaigns this user creates. Blank fields fall back to the organisation settings. The from address must be on a
            domain verified in SES (same domain as the organisation's needs no extra verification).
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="From name">
              <input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} />
            </Field>
            <Field label="From email">
              <input className="input" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} />
            </Field>
            <Field label="Reply-to">
              <input className="input" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />
            </Field>
            <Field label="Postal address">
              <input className="input" value={postalAddress} onChange={(e) => setPostalAddress(e.target.value)} />
            </Field>
          </div>
        </div>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}
