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
  if (!points.length) return <EmptyState title="No activity in this range" />;
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fill: CHART_TEXT, fontSize: 11 }} axisLine={{ stroke: CHART_GRID }} tickLine={false} />
          <YAxis tick={{ fill: CHART_TEXT, fontSize: 11 }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
          <Tooltip
            labelFormatter={(l) => fmtDay(String(l))}
            contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: CHART_GRID }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
          {keys.map((k) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              name={k}
              stroke={SERIES[k]}
              strokeWidth={2}
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
  if (!metrics.length) return <EmptyState title="No SES metric data points" />;
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
          <Tooltip labelFormatter={(l) => fmt(String(l))} contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: CHART_GRID }} />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
          {metrics.map((s) => (
            <Line
              key={s.metric}
              type="monotone"
              dataKey={s.metric}
              stroke={SES_SERIES[s.metric] ?? "#8a8984"}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
