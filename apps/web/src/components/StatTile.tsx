import type { LucideIcon } from "lucide-react";
import { compactNumber, percent } from "../lib/format";

type Tone = "good" | "warning" | "critical";

const VALUE_TONE: Record<Tone, string> = {
  critical: "text-red-700",
  warning: "text-amber-700",
  good: "text-emerald-700",
};

const DOT_TONE: Record<Tone, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  good: "bg-emerald-500",
};

/**
 * One KPI. `primary` tiles carry the headline numbers (larger figure, soft brand wash); the rest stay quieter
 * so the eye lands on outcomes first. A tone adds a small status dot and tints the figure.
 */
export function StatTile({
  label,
  value,
  rate,
  rateLabel,
  tone,
  primary,
  hint,
  icon: Icon,
}: {
  label: string;
  value: number;
  rate?: number;
  rateLabel?: string;
  tone?: Tone;
  primary?: boolean;
  /** Caption shown when there is no rate, e.g. the scope of the figure. */
  hint?: string;
  icon?: LucideIcon;
}) {
  return (
    <div
      className={
        "relative flex min-w-0 flex-col justify-between rounded-xl border border-gray-200/80 bg-white shadow-card transition-colors hover:border-gray-300 " +
        (primary ? "p-5" : "p-4")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-gray-500">
          {Icon && <Icon size={14} strokeWidth={1.75} className="shrink-0 text-gray-400" aria-hidden="true" />}
          <span className="truncate">{label}</span>
        </span>
        {tone && <span aria-hidden="true" className={"h-1.5 w-1.5 shrink-0 rounded-full " + DOT_TONE[tone]} />}
      </div>
      <div
        className={
          "mt-2 font-semibold tabular-nums tracking-tight " +
          (primary ? "text-[1.75rem] leading-9 " : "text-xl ") +
          (tone ? VALUE_TONE[tone] : "text-gray-900")
        }
      >
        {compactNumber(value)}
      </div>
      <div className="mt-1 min-h-[1.125rem] text-xs text-gray-500">
        {rate !== undefined ? (
          <>
            <span className="font-medium tabular-nums text-gray-700">{percent(rate)}</span> {rateLabel}
          </>
        ) : (
          hint
        )}
      </div>
    </div>
  );
}
