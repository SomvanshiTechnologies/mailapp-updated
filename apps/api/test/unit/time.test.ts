import { describe, expect, it } from "vitest";
import { addDays, localHourAndDay, nextSendWindow, utcDay } from "../../src/lib/time.js";

describe("time helpers", () => {
  it("computes local hour/day in a timezone", () => {
    // 2026-01-05 is a Monday. 03:30 UTC = 09:00 IST.
    const d = new Date("2026-01-05T03:30:00Z");
    expect(localHourAndDay(d, "Asia/Kolkata")).toEqual({ hour: 9, day: 1 });
    expect(localHourAndDay(d, "America/New_York")).toEqual({ hour: 22, day: 0 });
    expect(localHourAndDay(d, "Invalid/Zone").hour).toBe(3);
  });

  it("returns inWindow when inside the send window", () => {
    const rules = { sendWindowStartHour: 9, sendWindowEndHour: 17, sendDays: [1, 2, 3, 4, 5], timezone: "UTC" };
    const d = new Date("2026-01-05T10:00:00Z");
    expect(nextSendWindow(d, rules)).toEqual({ inWindow: true, next: d });
  });

  it("finds the next window start across the weekend", () => {
    const rules = { sendWindowStartHour: 9, sendWindowEndHour: 17, sendDays: [1, 2, 3, 4, 5], timezone: "UTC" };
    // Saturday 2026-01-10 12:00 UTC -> Monday 09:00 UTC
    const r = nextSendWindow(new Date("2026-01-10T12:00:00Z"), rules);
    expect(r.inWindow).toBe(false);
    expect(r.next.toISOString()).toBe("2026-01-12T09:00:00.000Z");
  });

  it("rolls to the next day after the window closes", () => {
    const rules = { sendWindowStartHour: 9, sendWindowEndHour: 17, sendDays: [1, 2, 3, 4, 5], timezone: "UTC" };
    const r = nextSendWindow(new Date("2026-01-05T17:30:00Z"), rules);
    expect(r.next.toISOString()).toBe("2026-01-06T09:00:00.000Z");
  });

  it("utcDay / addDays", () => {
    expect(utcDay(new Date("2026-03-01T23:59:59Z"))).toBe("2026-03-01");
    expect(addDays(new Date("2026-03-01T00:00:00Z"), 3).toISOString()).toBe("2026-03-04T00:00:00.000Z");
  });
});
