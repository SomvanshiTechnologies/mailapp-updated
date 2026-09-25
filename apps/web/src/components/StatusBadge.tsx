import type { CampaignStatus, EmailStatus, LeadStatus } from "@mailapp/shared";
import { titleCase } from "../lib/format";

type AnyStatus = LeadStatus | EmailStatus | CampaignStatus | string;

const TONE: Record<string, string> = {
  // neutral / in-progress
  pending: "bg-gray-100 text-gray-700",
  draft: "bg-gray-100 text-gray-700",
  queued: "bg-gray-100 text-gray-700",
  scheduled: "bg-gray-100 text-gray-700",
  researching: "bg-blue-50 text-blue-700",
  researched: "bg-blue-50 text-blue-700",
  drafting: "bg-blue-50 text-blue-700",
  sending: "bg-blue-50 text-blue-700",
  active: "bg-blue-50 text-blue-700",
  // needs attention
  pending_review: "bg-amber-50 text-amber-800",
  paused: "bg-amber-50 text-amber-800",
  // positive
  approved: "bg-emerald-50 text-emerald-700",
  sent: "bg-emerald-50 text-emerald-700",
  delivered: "bg-emerald-50 text-emerald-700",
  opened: "bg-teal-50 text-teal-700",
  clicked: "bg-teal-50 text-teal-700",
  replied: "bg-green-100 text-green-800",
  completed: "bg-green-100 text-green-800",
  // negative
  bounced: "bg-red-50 text-red-700",
  complained: "bg-red-100 text-red-800",
  failed: "bg-red-50 text-red-700",
  rejected: "bg-red-50 text-red-700",
  invalid: "bg-red-50 text-red-700",
  unsubscribed: "bg-orange-50 text-orange-700",
  suppressed: "bg-orange-50 text-orange-700",
  skipped: "bg-gray-100 text-gray-500",
  archived: "bg-gray-100 text-gray-500",
};

export function StatusBadge({ status, className = "" }: { status: AnyStatus; className?: string }) {
  const tone = TONE[status] ?? "bg-gray-100 text-gray-700";
  return (
    <span
      data-status={status}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tone} ${className}`}
    >
      {titleCase(status)}
    </span>
  );
}
