import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { MoreHorizontal, Pause, Pencil, Power, Trash2, UserPlus, Users as UsersIcon } from "lucide-react";
import { api } from "../lib/api";
import { compactNumber, formatDate, relativeTime } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { ConfirmDialog, EmptyState, ErrorBox, Field, Modal, PageHeader, Spinner } from "../components/ui";

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p.charAt(0))
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

function RoleBadge({ role }: { role: string }) {
  const cls = role === "admin" ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-gray-100 text-gray-600 ring-gray-200";
  return <span className={"inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset " + cls}>{role}</span>;
}

/**
 * Row actions live in a menu so the table stays narrow; every item keeps its original handler and disabled rule.
 * The menu is portalled to the page and positioned from the button, so the table's overflow can't clip it.
 */
function RowMenu({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = pos !== null;
  const close = () => setPos(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);
  const toggle = () => {
    if (open) return close();
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  return (
    <>
      <button ref={btn} className="btn-ghost btn-sm !px-1.5" aria-label="More actions" aria-expanded={open} onClick={toggle}>
        <MoreHorizontal size={16} />
      </button>
      {pos &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            style={{ position: "fixed", top: pos.top, right: pos.right }}
            className="z-50 w-48 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-pop"
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

function MenuItem({
  icon: Icon,
  tone,
  disabled,
  title,
  onClick,
  children,
}: {
  icon: typeof Pause;
  tone?: "warning" | "danger";
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const color = tone === "danger" ? "text-red-700" : tone === "warning" ? "text-amber-700" : "text-gray-700";
  return (
    <button
      role="menuitem"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={"flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 " + color}
    >
      <Icon size={15} strokeWidth={1.75} />
      {children}
    </button>
  );
}

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

  const users = q.data?.items ?? [];
  const summary = [
    { label: "Users", value: users.length },
    { label: "Active", value: users.filter((u) => u.isActive).length },
    { label: "Sent today", value: (stats.data?.items ?? []).reduce((n, s) => n + s.sentToday, 0) },
    { label: "Queued to send", value: (stats.data?.items ?? []).reduce((n, s) => n + s.pendingSend, 0) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        subtitle="Who sends what: campaigns owned, emails sent and queued per user"
        actions={
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <UserPlus size={15} />
            Add user
          </button>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox message={(q.error as Error).message} />
      ) : !users.length ? (
        <EmptyState compact icon={<UsersIcon size={18} />} title="No users" hint="Add the first user to give someone access." />
      ) : (
        <>
          <div className="grid grid-cols-2 divide-gray-100 rounded-xl border border-gray-200/80 bg-white shadow-card md:grid-cols-4 md:divide-x">
            {summary.map((m) => (
              <div key={m.label} className="px-5 py-3.5">
                <div className="text-xs font-medium text-gray-500">{m.label}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-gray-900">{compactNumber(m.value)}</div>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-card">
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="pl-5">User</th>
                    <th>Role</th>
                    <th>Sends as</th>
                    <th className="text-right">Campaigns</th>
                    <th className="text-right">Sent</th>
                    <th className="text-right">Queued</th>
                    <th>Last activity</th>
                    <th className="pr-5"></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const s = statsById.get(u.id);
                    const self = u.id === me?.id;
                    return (
                      <tr key={u.id}>
                        <td className="pl-5">
                          <div className={"flex items-center gap-3 " + (u.isActive ? "" : "opacity-60")}>
                            <span
                              aria-hidden="true"
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600"
                            >
                              {initials(u.name)}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 font-medium text-gray-900">
                                <span className="truncate">{u.name}</span>
                                {self && <span className="rounded bg-gray-100 px-1.5 text-2xs font-medium text-gray-500">You</span>}
                                {!u.isActive && <span className="rounded bg-gray-100 px-1.5 text-2xs font-medium text-gray-500">Inactive</span>}
                              </div>
                              <div className="truncate text-xs text-gray-500">{u.email}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <RoleBadge role={u.role} />
                          {u.dashboardScope === "all" && u.role !== "admin" && <div className="mt-1 text-xs text-gray-500">Sees all dashboards</div>}
                        </td>
                        <td className="text-xs">
                          {u.fromEmail ? (
                            <>
                              {u.fromName && <div className="font-medium text-gray-800">{u.fromName}</div>}
                              <div className="text-gray-500">{u.fromEmail}</div>
                            </>
                          ) : (
                            <span className="text-gray-400">Organisation default</span>
                          )}
                        </td>
                        <td className="text-right">
                          <div className="font-medium tabular-nums text-gray-900">{s?.campaigns ?? 0}</div>
                          <div className={"text-xs tabular-nums " + (s?.activeCampaigns ? "font-medium text-brand-700" : "text-gray-400")}>
                            {s?.activeCampaigns ?? 0} active
                          </div>
                        </td>
                        <td className="text-right">
                          <div className="font-medium tabular-nums text-gray-900">{compactNumber(s?.sentToday ?? 0)} today</div>
                          <div className="text-xs tabular-nums text-gray-500">
                            {compactNumber(s?.sentLast7Days ?? 0)} in 7d · {compactNumber(s?.sentTotal ?? 0)} total
                          </div>
                        </td>
                        <td className={"text-right tabular-nums " + (s?.pendingSend ? "font-medium text-amber-700" : "text-gray-400")}>{s?.pendingSend ?? 0}</td>
                        <td className="text-xs text-gray-500">
                          <div title={formatDate(s?.lastSentAt ?? null)}>Sent {s?.lastSentAt ? relativeTime(s.lastSentAt) : "never"}</div>
                          <div title={formatDate(u.lastLoginAt)}>Login {u.lastLoginAt ? relativeTime(u.lastLoginAt) : "never"}</div>
                        </td>
                        <td className="pr-5">
                          <div className="flex items-center justify-end gap-1">
                            <button className="btn-secondary btn-sm" onClick={() => setEditing(u)}>
                              <Pencil size={13} />
                              Edit
                            </button>
                            <RowMenu>
                              {(close) => (
                                <>
                                  <MenuItem
                                    icon={Power}
                                    disabled={toggleActive.isPending || self}
                                    onClick={() => {
                                      close();
                                      toggleActive.mutate(u);
                                    }}
                                  >
                                    {u.isActive ? "Deactivate" : "Activate"}
                                  </MenuItem>
                                  <MenuItem
                                    icon={Pause}
                                    tone="warning"
                                    disabled={!s?.activeCampaigns}
                                    title="Pause every active campaign this user owns"
                                    onClick={() => {
                                      close();
                                      setStopping(u);
                                    }}
                                  >
                                    Stop sending
                                  </MenuItem>
                                  <div className="my-1 border-t border-gray-100" />
                                  <MenuItem
                                    icon={Trash2}
                                    tone="danger"
                                    disabled={self}
                                    onClick={() => {
                                      close();
                                      setDeleting(u);
                                    }}
                                  >
                                    Delete user
                                  </MenuItem>
                                </>
                              )}
                            </RowMenu>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
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
      <div className="space-y-6">
        <section>
          <h3 className="text-sm font-semibold text-gray-900">Account</h3>
          <p className="mb-3 mt-0.5 text-xs text-gray-500">Who they are, how they sign in and what they can see.</p>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2">
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
        </section>
        <section className="border-t border-gray-100 pt-5">
          <h3 className="text-sm font-semibold text-gray-900">Sender identity</h3>
          <p className="mb-3 mt-0.5 text-xs text-gray-500">
            Used on campaigns this user creates. Blank fields fall back to the organisation settings. The from address must be on a
            domain verified in SES (same domain as the organisation's needs no extra verification).
          </p>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2">
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
        </section>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}
