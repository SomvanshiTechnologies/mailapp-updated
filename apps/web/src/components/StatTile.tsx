import { compactNumber, percent } from "../lib/format";

export function StatTile({
  label,
  value,
  rate,
  rateLabel,
  tone,
}: {
  label: string;
  value: number;
  rate?: number;
  rateLabel?: string;
  tone?: "good" | "warning" | "critical";
}) {
  const toneCls =
    tone === "critical" ? "text-red-700" : tone === "warning" ? "text-amber-700" : tone === "good" ? "text-green-700" : "text-gray-900";
  return (
    <div className="card">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={"mt-1 text-2xl font-semibold " + toneCls}>{compactNumber(value)}</div>
      {rate !== undefined && (
        <div className="mt-0.5 text-xs text-gray-500">
          {percent(rate)} {rateLabel}
        </div>
      )}
    </div>
  );
}
