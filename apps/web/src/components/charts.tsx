import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import type { SesCloudWatchSeries, TimeseriesPoint } from "@mailapp/shared";
import { CHART_GRID, CHART_TEXT, SERIES, SES_SERIES, type SeriesKey } from "../lib/viz";
import { EmptyState } from "./ui";

const DEFAULT_KEYS: SeriesKey[] = ["sent", "delivered", "opened", "replied", "bounced"];

function fmtDay(d: string): string {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TimeseriesChart({
  points,
  keys = DEFAULT_KEYS,
  height = 260,
}: {
  points: TimeseriesPoint[];
  keys?: SeriesKey[];
  height?: number;
}) {
  const hasData = points.some((p) => keys.some((k) => Number(p[k]) > 0));
  if (!points.length || !hasData)
    return (
      <EmptyState
        compact
        icon={<svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v18h18M7 15l4-4 3 3 5-6" /></svg>}
        title="No activity in this range"
        hint="Sent, delivered, opened and replied counts appear here once emails start going out."
      />
    );
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fill: CHART_TEXT, fontSize: 11 }} axisLine={{ stroke: CHART_GRID }} tickLine={false} />
          <YAxis tick={{ fill: CHART_TEXT, fontSize: 11 }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
          <Tooltip
            labelFormatter={(l) => fmtDay(String(l))}
            contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: CHART_GRID, boxShadow: "0 8px 24px rgb(15 27 45 / 0.10)" }}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
          {keys.map((k) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              name={k}
              stroke={SERIES[k]}
              strokeWidth={1.75}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SesMetricsChart({ series, height = 240 }: { series: SesCloudWatchSeries[]; height?: number }) {
  const metrics = series.filter((s) => s.points.length > 0);
  if (!metrics.length)
    return (
      <EmptyState
        compact
        icon={<svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v18h18M7 15l4-4 3 3 5-6" /></svg>}
        title="No SES metric data points"
        hint="Send, delivery, bounce and complaint series show up after the first sends."
      />
    );
  // merge into rows keyed by timestamp
  const rows = new Map<string, Record<string, number | string>>();
  for (const s of metrics) {
    for (const p of s.points) {
      const row = rows.get(p.timestamp) ?? { timestamp: p.timestamp };
      row[s.metric] = p.value;
      rows.set(p.timestamp, row);
    }
  }
  const data = [...rows.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const fmt = (t: string) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="timestamp" tickFormatter={fmt} tick={{ fill: CHART_TEXT, fontSize: 11 }} axisLine={{ stroke: CHART_GRID }} tickLine={false} />
          <YAxis tick={{ fill: CHART_TEXT, fontSize: 11 }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
          <Tooltip labelFormatter={(l) => fmt(String(l))} contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: CHART_GRID, boxShadow: "0 8px 24px rgb(15 27 45 / 0.10)" }} />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
          {metrics.map((s) => (
            <Line
              key={s.metric}
              type="monotone"
              dataKey={s.metric}
              stroke={SES_SERIES[s.metric] ?? "#8a8984"}
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
