/** YYYY-MM-DD in UTC. */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Local hour (0-23) and weekday (0=Sunday) of `d` in an IANA timezone. */
export function localHourAndDay(d: Date, timezone: string): { hour: number; day: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false, weekday: "short" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", hour12: false, weekday: "short" });
  }
  const parts = fmt.formatToParts(d);
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hour = Number(hourStr) % 24;
  return { hour, day: Math.max(0, days.indexOf(weekday)) };
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/**
 * Whether `d` falls inside the allowed send window. If not, returns the next Date that does
 * (searching hour by hour up to 8 days ahead).
 */
export function nextSendWindow(
  d: Date,
  rules: { sendWindowStartHour: number; sendWindowEndHour: number; sendDays: number[]; timezone: string },
): { inWindow: boolean; next: Date } {
  const inside = (t: Date) => {
    const { hour, day } = localHourAndDay(t, rules.timezone);
    return rules.sendDays.includes(day) && hour >= rules.sendWindowStartHour && hour < rules.sendWindowEndHour;
  };
  if (inside(d)) return { inWindow: true, next: d };
  // Round up to the next hour boundary then step hourly.
  let t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  t = new Date(t.getTime() + 3_600_000);
  for (let i = 0; i < 24 * 8; i++) {
    if (inside(t)) return { inWindow: false, next: t };
    t = new Date(t.getTime() + 3_600_000);
  }
  return { inWindow: false, next: d };
}
