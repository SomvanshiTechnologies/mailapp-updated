import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Cpu,
  Database,
  ListTodo,
  Mail,
  MailX,
  Reply,
  ShieldAlert,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { CampaignCounts, CampaignDto, SesAccountInfo, SystemStatus } from "@mailapp/shared";
import { compactNumber, formatDate, percent, relativeTime, titleCase } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import { EmptyState, StatusDot } from "./ui";

export type Tone = "good" | "warning" | "critical" | "neutral";

/** Sum of every campaign's lead counts (archived campaigns are left out by the caller). */
export function sumCounts(list: CampaignCounts[]): CampaignCounts {
  const zero: CampaignCounts = {
    total: 0, pending: 0, researching: 0, drafting: 0, pendingReview: 0, approved: 0, sent: 0, delivered: 0,
    opened: 0, clicked: 0, replied: 0, bounced: 0, complained: 0, unsubscribed: 0, failed: 0, other: 0,
  };
  for (const c of list) for (const k of Object.keys(zero) as Array<keyof CampaignCounts>) zero[k] += c[k];
  return zero;
}

/* ------------------------------------------------------------------ section frame */

export function Section({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"rounded-xl border border-gray-200/80 bg-white shadow-card " + className}>
      <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold tracking-tight text-gray-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ secondary metrics */

export function SecondaryMetrics({
  items,
}: {
  items: Array<{ label: string; value: number; rate?: number; rateLabel?: string; tone?: "warning" | "critical" }>;
}) {
  return (
    <div className="grid grid-cols-2 divide-gray-100 rounded-xl border border-gray-200/80 bg-white shadow-card sm:grid-cols-3 md:grid-cols-5 md:divide-x">
      {items.map((m) => (
        <div key={m.label} className="px-5 py-3.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
            {m.label}
            {m.tone && <StatusDot tone={m.tone} />}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={"text-lg font-semibold tabular-nums tracking-tight " + (m.tone === "critical" ? "text-red-700" : m.tone === "warning" ? "text-amber-700" : "text-gray-900")}>
              {compactNumber(m.value)}
            </span>
            {m.rate !== undefined && (
              <span className="text-xs tabular-nums text-gray-500">
                {percent(m.rate)} {m.rateLabel}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ pipeline */

interface Stage {
  key: string;
  label: string;
  value: number;
  /** Highlight a stage where leads are waiting on a person. */
  attention?: boolean;
  hint: string;
}

/**
 * Where leads are right now. The first five stages are current positions; "Sent" counts every lead that has
 * gone out (including those that later replied), so the bar for it can exceed the others.
 */
export function PipelineCard({ counts }: { counts: CampaignCounts }) {
  const stopped = counts.bounced + counts.complained + counts.unsubscribed + counts.failed + counts.other;
  const stages: Stage[] = [
    { key: "queued", label: "Awaiting research", value: counts.pending, hint: "Imported, not started" },
    { key: "research", label: "Researching", value: counts.researching, hint: "LLM is profiling the lead" },
    { key: "draft", label: "Drafting", value: counts.drafting, hint: "Email being written" },
    { key: "review", label: "Pending review", value: counts.pendingReview, attention: counts.pendingReview > 0, hint: "Waiting for a reviewer" },
    { key: "approved", label: "Approved", value: counts.approved, hint: "Approved or sending" },
    { key: "sent", label: "Sent", value: counts.sent, hint: "Reached SES" },
    { key: "replied", label: "Replied", value: counts.replied, hint: "Follow-ups stop" },
  ];
  const total = counts.total;
  return (
    <Section
      title="Lead pipeline"
      subtitle={total ? `${compactNumber(total)} leads across active and past campaigns` : "How leads move from import to reply"}
      action={
        stopped > 0 ? (
          <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-600">
            {compactNumber(stopped)} stopped (bounced, failed, unsubscribed, other)
          </span>
        ) : undefined
      }
    >
      {total === 0 ? (
        <EmptyState
          compact
          icon={<ListTodo size={18} />}
          title="No leads in the pipeline yet"
          hint="Import a lead sheet in a new campaign. Each lead appears here as it moves through research, drafting and review."
          action={
            <Link to="/campaigns/new" className="btn-primary btn-sm mt-2">
              New campaign
            </Link>
          }
        />
      ) : (
        <ol className="grid grid-cols-2 gap-y-5 sm:grid-cols-4 lg:grid-cols-7 lg:gap-y-0">
          {stages.map((s, i) => {
            const share = total ? Math.min(100, (s.value / total) * 100) : 0;
            return (
              <li key={s.key} className={"relative min-w-0 pr-4 " + (i > 0 ? "lg:border-l lg:border-gray-100 lg:pl-4" : "")}>
                <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
                  <span className="truncate">{s.label}</span>
                  {s.attention && <StatusDot tone="warning" />}
                </div>
                <div className={"mt-1 text-xl font-semibold tabular-nums tracking-tight " + (s.attention ? "text-amber-700" : "text-gray-900")}>
                  {compactNumber(s.value)}
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
                  <div className={"h-full rounded-full " + (s.attention ? "bg-amber-500" : "bg-brand-500")} style={{ width: `${share}%` }} />
                </div>
                <div className="mt-1.5 truncate text-[11px] text-gray-400">{s.hint}</div>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ action center */

export interface ActionItem {
  key: string;
  icon: LucideIcon;
  tone: "warning" | "critical" | "info";
  title: string;
  detail: string;
  count: number;
  to: string;
}

const ACTION_TONE: Record<ActionItem["tone"], string> = {
  critical: "bg-red-50 text-red-600",
  warning: "bg-amber-50 text-amber-600",
  info: "bg-brand-50 text-brand-600",
};

export function ActionCenter({ items, loading }: { items: ActionItem[]; loading?: boolean }) {
  const open = items.filter((i) => i.count > 0);
  return (
    <Section
      title="Action center"
      subtitle={open.length ? `${open.length} thing${open.length === 1 ? "" : "s"} need${open.length === 1 ? "s" : ""} attention` : "Items that need a person"}
    >
      {loading ? (
        <p className="py-6 text-center text-xs text-gray-500">Checking…</p>
      ) : open.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-8 text-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircle2 size={18} />
          </span>
          <p className="mt-1 text-sm font-medium text-gray-800">All clear</p>
          <p className="max-w-[16rem] text-xs text-gray-500">No drafts waiting, no failed jobs and no new replies.</p>
        </div>
      ) : (
        <ul className="-mx-2 divide-y divide-gray-100">
          {open.map((i) => (
            <li key={i.key}>
              <Link to={i.to} className="group flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-gray-50">
                <span className={"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg " + ACTION_TONE[i.tone]}>
                  <i.icon size={16} strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-900">{i.title}</span>
                  <span className="block truncate text-xs text-gray-500">{i.detail}</span>
                </span>
                <span className="text-sm font-semibold tabular-nums text-gray-900">{compactNumber(i.count)}</span>
                <ChevronRight size={14} className="text-gray-300 transition-colors group-hover:text-gray-500" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export const ACTION_ICONS = { review: ClipboardCheck, validation: ShieldAlert, failedLeads: AlertTriangle, failedSends: MailX, replies: Reply };

/* ------------------------------------------------------------------ campaign overview */

export function CampaignOverview({ campaigns }: { campaigns: CampaignDto[] }) {
  const recent = [...campaigns].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  return (
    <Section
      title="Recent campaigns"
      subtitle="Most recently updated"
      action={
        <Link to="/campaigns" className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
          View all <ArrowRight size={12} />
        </Link>
      }
    >
      {recent.length === 0 ? (
        <EmptyState compact icon={<Mail size={18} />} title="No campaigns yet" hint="Upload a lead sheet to create your first campaign." />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="pl-5">Campaign</th>
                <th>Status</th>
                <th className="text-right">Leads</th>
                <th className="text-right" title="Leads that have a draft: in review, approved or sent">Drafts</th>
                <th className="text-right">Sent</th>
                <th className="text-right">Replies</th>
                <th className="pr-5 text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => {
                const k = c.counts;
                const drafts = k.pendingReview + k.approved + k.sent + k.bounced + k.complained;
                return (
                  <tr key={c.id}>
                    <td className="max-w-[16rem] pl-5">
                      <Link to={`/campaigns/${c.id}`} className="block truncate font-medium text-gray-900 hover:text-brand-700">
                        {c.name}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="text-right tabular-nums">{compactNumber(k.total)}</td>
                    <td className="text-right tabular-nums">{compactNumber(drafts)}</td>
                    <td className="text-right tabular-nums">{compactNumber(k.sent)}</td>
                    <td className="text-right tabular-nums">{compactNumber(k.replied)}</td>
                    <td className="whitespace-nowrap pr-5 text-right text-xs text-gray-500">{relativeTime(c.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ system health */

function HealthRow({ icon: Icon, label, detail, tone, value }: { icon: LucideIcon; label: string; detail?: string; tone: Tone; value: string }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <Icon size={16} strokeWidth={1.75} className="shrink-0 text-gray-400" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-gray-900">{label}</span>
        {detail && <span className="block truncate text-xs text-gray-500">{detail}</span>}
      </span>
      <span className="inline-flex shrink-0 items-center gap-2 text-sm font-medium text-gray-900">
        <StatusDot tone={tone} />
        {value}
      </span>
    </li>
  );
}

/** The worker has no endpoint of its own; its SES sync runs every 5 minutes, so a fresh sync means it is alive. */
const WORKER_FRESH_MS = 12 * 60_000;

export function HealthCard({ system, ses }: { system?: SystemStatus; ses?: SesAccountInfo }) {
  if (!system) return <Section title="System health"><p className="py-6 text-center text-xs text-gray-500">Loading…</p></Section>;

  const syncAge = system.lastSesSyncAt ? Date.now() - new Date(system.lastSesSyncAt).getTime() : null;
  const workerOk = syncAge !== null && syncAge < WORKER_FRESH_MS;
  const failedJobs = system.queues.reduce((n, q) => n + q.failed, 0);
  const waiting = system.queues.reduce((n, q) => n + q.created + q.retry, 0);

  const sesCritical = Boolean(ses?.error) || (ses ? !ses.sendingEnabled : false);
  const sesLimited = ses ? !ses.productionAccessEnabled || (ses.enforcementStatus !== null && ses.enforcementStatus !== "HEALTHY") : false;
  const sesTone: Tone = !ses ? "neutral" : sesCritical ? "critical" : sesLimited ? "warning" : "good";
  const sesValue = !ses ? "—" : sesCritical ? "Needs attention" : ses.productionAccessEnabled ? "Production" : "Sandbox";

  const attention = system.db !== "ok" || system.queue !== "ok" || !workerOk || failedJobs > 0 || sesTone === "critical";
  const overall = attention ? ["Needs attention", "bg-red-50 text-red-700 ring-red-200"] : ["All systems operational", "bg-emerald-50 text-emerald-700 ring-emerald-200"];

  const quota = ses?.sendQuota && ses.sendQuota.max24HourSend > 0 ? ses.sendQuota : null;
  const ratio = quota ? Math.min(1, quota.sentLast24Hours / quota.max24HourSend) : 0;

  return (
    <Section
      title="System health"
      action={<span className={"shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset " + overall[1]}>{overall[0]}</span>}
    >
      <ul className="divide-y divide-gray-100">
        <HealthRow icon={Database} label="Database" tone={system.db === "ok" ? "good" : "critical"} value={system.db === "ok" ? "Operational" : "Error"} />
        <HealthRow
          icon={Cpu}
          label="Worker"
          detail={system.lastSesSyncAt ? `Last heartbeat ${relativeTime(system.lastSesSyncAt)}` : "No heartbeat recorded yet"}
          tone={workerOk ? "good" : "warning"}
          value={workerOk ? "Running" : "No recent activity"}
        />
        <HealthRow
          icon={ListTodo}
          label="Job queue"
          detail={`${compactNumber(waiting)} waiting${failedJobs ? ` · ${compactNumber(failedJobs)} failed` : ""}`}
          tone={system.queue !== "ok" ? "critical" : failedJobs > 0 ? "warning" : "good"}
          value={system.queue !== "ok" ? "Error" : failedJobs > 0 ? "Failures" : "Operational"}
        />
        <HealthRow
          icon={Sparkles}
          label="LLM provider"
          detail={system.llmProvider === "mock" ? "Placeholder drafts" : undefined}
          tone={system.llmProvider === "mock" ? "warning" : "good"}
          value={titleCase(system.llmProvider)}
        />
        <HealthRow
          icon={Mail}
          label="Amazon SES"
          detail={ses ? `${ses.region} · ${system.sesMode === "mock" ? "dry run" : "live"}` : system.sesMode === "mock" ? "Dry run" : undefined}
          tone={sesTone}
          value={sesValue}
        />
      </ul>
      {quota && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="flex items-baseline justify-between text-xs text-gray-500">
            <span>SES 24h quota</span>
            <span className="tabular-nums">
              {compactNumber(quota.sentLast24Hours)} / {compactNumber(quota.max24HourSend)}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-gray-100">
            <div className={"h-full rounded-full " + (ratio >= 0.95 ? "bg-red-500" : ratio >= 0.8 ? "bg-amber-500" : "bg-brand-500")} style={{ width: `${ratio * 100}%` }} />
          </div>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <span>Checked {formatDate(system.now)}</span>
        <Link to="/system" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
          Details <ArrowRight size={12} />
        </Link>
      </div>
    </Section>
  );
}
