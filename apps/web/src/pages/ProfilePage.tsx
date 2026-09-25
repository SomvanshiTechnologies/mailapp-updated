import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChangePasswordSchema, UpdateProfileSchema, type SettingsDto, type UserDto } from "@mailapp/shared";
import { api, errorMessage } from "../lib/api";
import { formatDate } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { Banner, ErrorBox, Field, PageHeader, Spinner } from "../components/ui";

/**
 * A user's own settings: display name, the sender identity used for campaigns they create
 * (falls back to the organisation settings when blank) and password change.
 */
export function ProfilePage() {
  const { user, refreshUser, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: SettingsDto }>("/api/settings") });
  if (!user) return <Spinner />;
  const org = settings.data?.settings;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="My profile" subtitle={`${user.email} · ${user.role}`} />
      <SenderForm user={user} org={org} onSaved={refreshUser} />
      <ImapForm user={user} onSaved={refreshUser} />
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold">My instructions</h2>
        <p className="text-sm text-gray-600">
          Tone, format, rules and signature documents you keep under <em>Mine</em> on the Instructions page override the organisation's
          for campaigns you create. Kinds you have not customised use the organisation's documents.
        </p>
        <Link to="/instructions?scope=mine" className="text-sm text-brand-700 hover:underline">
          Manage my instructions →
        </Link>
      </div>
      <PasswordForm
        onChanged={async () => {
          toast.success("Password changed. Please sign in again.");
          await logout();
          navigate("/login");
        }}
      />
    </div>
  );
}

function SenderForm({ user, org, onSaved }: { user: UserDto; org?: SettingsDto; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [fromEmail, setFromEmail] = useState(user.fromEmail ?? "");
  const [fromName, setFromName] = useState(user.fromName ?? "");
  const [replyTo, setReplyTo] = useState(user.replyTo ?? "");
  const [postalAddress, setPostalAddress] = useState(user.postalAddress ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api.patch<{ user: UserDto }>("/api/auth/me", body),
    onSuccess: async () => {
      toast.success("Profile saved");
      await onSaved();
    },
    onError: (e) => toast.error(e, "Save failed"),
  });
  const submit = () => {
    setError(null);
    const parsed = UpdateProfileSchema.safeParse({ name, fromEmail, fromName, replyTo, postalAddress });
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(`${i.path.join(".")}: ${i.message}`);
      return;
    }
    save.mutate(parsed.data);
  };
  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Sender identity</h2>
        <p className="text-xs text-gray-500">
          Used as the From / Reply-To on campaigns you create. Leave a field blank to use the organisation default
          {org ? ` (${org.fromName} <${org.fromEmail}>)` : ""}. The address must be on a domain verified in SES.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Display name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="From name" hint={org ? `Default: ${org.fromName}` : undefined}>
          <input className="input" value={fromName} placeholder={org?.fromName} onChange={(e) => setFromName(e.target.value)} />
        </Field>
        <Field label="From email" hint={org ? `Default: ${org.fromEmail}` : undefined}>
          <input className="input" type="email" value={fromEmail} placeholder={org?.fromEmail} onChange={(e) => setFromEmail(e.target.value)} />
        </Field>
        <Field
          label="Reply-to"
          hint={
            user.effectiveReplyTo
              ? `Currently ${user.effectiveReplyTo}${user.replyTo ? "" : " (reply-capture address, so replies are picked up automatically)"}`
              : org?.replyTo
                ? `Default: ${org.replyTo}`
                : "Default: same as from email"
          }
        >
          <input className="input" type="email" value={replyTo} placeholder={org?.replyTo ?? ""} onChange={(e) => setReplyTo(e.target.value)} />
        </Field>
      </div>
      <Field label="Postal address (printed under your emails)" hint={org?.postalAddress ? `Default: ${org.postalAddress}` : undefined}>
        <input className="input" value={postalAddress} placeholder={org?.postalAddress ?? ""} onChange={(e) => setPostalAddress(e.target.value)} />
      </Field>
      {error && <ErrorBox message={error} />}
      <div className="flex justify-end">
        <button className="btn-primary" disabled={save.isPending} onClick={submit}>
          {save.isPending ? "Saving…" : "Save profile"}
        </button>
      </div>
    </div>
  );
}

/**
 * Reply polling of the user's own mailbox. Needed when they set a personal Reply-To (their
 * real inbox) instead of relying on the reply-capture domain.
 */
function ImapForm({ user, onSaved }: { user: UserDto; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(user.imap.enabled);
  const [host, setHost] = useState(user.imap.host ?? "");
  const [port, setPort] = useState(String(user.imap.port || 993));
  const [login, setLogin] = useState(user.imap.user ?? user.fromEmail ?? "");
  const [password, setPassword] = useState("");
  const [mailbox, setMailbox] = useState(user.imap.mailbox || "INBOX");
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const body = () => ({
    imapEnabled: enabled,
    imapHost: host,
    imapPort: Number(port) || 993,
    imapUser: login,
    imapMailbox: mailbox,
    ...(password ? { imapPassword: password } : {}),
  });
  const save = useMutation({
    mutationFn: () => api.patch<{ user: UserDto }>("/api/auth/me", body()),
    onSuccess: async () => {
      toast.success("Mailbox settings saved");
      setPassword("");
      await onSaved();
    },
    onError: (e) => toast.error(e, "Save failed"),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; recentMessages: number }>("/api/auth/me/imap-test", { imapHost: host, imapPort: Number(port) || 993, imapUser: login, imapMailbox: mailbox, ...(password ? { imapPassword: password } : {}) }),
    onSuccess: (r) => setTestResult(`Connected. ${r.recentMessages} message(s) in the last 3 days.`),
    onError: (e) => setTestResult(errorMessage(e)),
  });
  const submit = () => {
    setError(null);
    const parsed = UpdateProfileSchema.safeParse(body());
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(`${i.path.join(".")}: ${i.message}`);
      return;
    }
    save.mutate();
  };
  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Reply polling (IMAP)</h2>
        <p className="text-xs text-gray-500">
          Only needed if you set your own Reply-To above. The worker then reads your mailbox every 2 minutes (read-only, nothing is
          marked or moved) and marks leads as replied. For Hostinger: host imap.hostinger.com, port 993, your full address and mailbox password.
        </p>
      </div>
      {user.imap.enabled && (
        <div className={"rounded-md border px-3 py-2 text-xs " + (user.imap.lastError ? "border-red-200 bg-red-50 text-red-800" : "border-gray-200 bg-gray-50 text-gray-700")}>
          Last poll: {formatDate(user.imap.lastPolledAt)}
          {user.imap.lastError ? ` · error: ${user.imap.lastError}` : user.imap.lastPolledAt ? " · OK" : " · not yet run"}
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Poll this mailbox for replies
      </label>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Field label="IMAP host">
          <input className="input" value={host} placeholder="imap.hostinger.com" onChange={(e) => setHost(e.target.value)} />
        </Field>
        <Field label="Port">
          <input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
        <Field label="Username">
          <input className="input" value={login} onChange={(e) => setLogin(e.target.value)} />
        </Field>
        <Field label="Mailbox">
          <input className="input" value={mailbox} onChange={(e) => setMailbox(e.target.value)} />
        </Field>
      </div>
      <Field label={user.imap.passwordSet ? "Password (leave blank to keep the stored one)" : "Password"} hint="Stored encrypted; never shown again">
        <input className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {testResult && <div className="text-xs text-gray-700">{testResult}</div>}
      {error && <ErrorBox message={error} />}
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" disabled={test.isPending || !host || !login} onClick={() => test.mutate()}>
          {test.isPending ? "Testing…" : "Test connection"}
        </button>
        <button className="btn-primary" disabled={save.isPending} onClick={submit}>
          {save.isPending ? "Saving…" : "Save mailbox settings"}
        </button>
      </div>
    </div>
  );
}

function PasswordForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (body: unknown) => api.post("/api/auth/change-password", body),
    onSuccess: () => onChanged(),
    onError: (e) => toast.error(e, "Password change failed"),
  });
  const submit = () => {
    setError(null);
    if (next !== confirm) {
      setError("New passwords do not match");
      return;
    }
    const parsed = ChangePasswordSchema.safeParse({ currentPassword: current, newPassword: next });
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(`${i.path.join(".")}: ${i.message}`);
      return;
    }
    change.mutate(parsed.data);
  };
  return (
    <div className="card space-y-4">
      <h2 className="text-sm font-semibold">Change password</h2>
      <Banner kind="info">Changing your password signs you out of every device.</Banner>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Current password">
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" hint="At least 12 characters">
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirm new password">
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      </div>
      {error && <ErrorBox message={error} />}
      <div className="flex justify-end">
        <button className="btn-secondary" disabled={change.isPending || !current || !next} onClick={submit}>
          {change.isPending ? "Changing…" : "Change password"}
        </button>
      </div>
    </div>
  );
}
