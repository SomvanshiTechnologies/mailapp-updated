import { type ReactNode, useEffect } from "react";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-gray-500" role="status">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-brand-500" />
      {label}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 py-10 text-center">
      <p className="text-sm font-medium text-gray-700">{title}</p>
      {hint && <p className="max-w-md text-xs text-gray-500">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
      {message}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-gray-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={"max-h-[90vh] w-full overflow-y-auto rounded-lg bg-white shadow-xl " + (wide ? "max-w-4xl" : "max-w-lg")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm text-gray-700">{message}</div>
    </Modal>
  );
}

export function Field({
  label,
  hint,
  children,
  error,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  error?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between py-2 text-xs text-gray-600">
      <span>
        {total === 0 ? "0 results" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
      </span>
      <div className="flex items-center gap-1">
        <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Prev
        </button>
        <span className="px-2">
          {page} / {pages}
        </span>
        <button className="btn-secondary btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ key: T; label: string; count?: number }>;
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="mb-4 flex gap-1 border-b border-gray-200" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={t.key === value}
          onClick={() => onChange(t.key)}
          className={
            "-mb-px border-b-2 px-3 py-2 text-sm " +
            (t.key === value
              ? "border-brand-500 font-medium text-brand-700"
              : "border-transparent text-gray-500 hover:text-gray-800")
          }
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 text-xs text-gray-600">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function JsonView({ value, collapsed = true, label = "Raw JSON" }: { value: unknown; collapsed?: boolean; label?: string }) {
  return (
    <details open={!collapsed} className="rounded-md border border-gray-200 bg-gray-50">
      <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-gray-600">{label}</summary>
      <pre className="max-h-80 overflow-auto px-3 pb-3 text-xs text-gray-800">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function KeyValue({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-gray-500">{k}</dt>
          <dd className="break-words text-gray-900">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Banner({ kind, children }: { kind: "warning" | "info" | "danger"; children: ReactNode }) {
  const cls =
    kind === "danger"
      ? "border-red-300 bg-red-50 text-red-900"
      : kind === "warning"
        ? "border-amber-300 bg-amber-50 text-amber-900"
        : "border-blue-200 bg-blue-50 text-blue-900";
  return <div className={"rounded-md border px-3 py-2 text-sm " + cls}>{children}</div>;
}
