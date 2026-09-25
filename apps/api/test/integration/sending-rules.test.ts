import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_SETTINGS, JOB_QUEUES } from "@mailapp/shared";
import { createTestContext, json, loginAs, req, type TestContext } from "../helpers/context.js";
import { createCampaign, createService, leadRows } from "../helpers/fixtures.js";
import { emails, leads } from "../../src/db/schema.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => ctx.reset());

async function putSettings(overrides: Record<string, unknown>) {
  const admin = await loginAs(ctx, "admin", `admin-${Date.now()}@test.local`);
  const current = json(await req(ctx, admin, { method: "GET", url: "/api/settings" })).settings;
  const { updatedAt: _u, ...rest } = current;
  const res = await req(ctx, admin, { method: "PUT", url: "/api/settings", payload: { ...rest, ...overrides } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return admin;
}

describe("send window, daily cap and suppression at send time", () => {
  it("defers sends outside the window and schedules a delayed job", async () => {
    // A window that is guaranteed closed: only Sundays 03:00-04:00 UTC unless we are unlucky.
    const now = new Date();
    const closedDay = (now.getUTCDay() + 3) % 7;
    await putSettings({ hardRules: { ...DEFAULT_SETTINGS.hardRules, sendDays: [closedDay], sendWindowStartHour: 3, sendWindowEndHour: 4, timezone: "UTC" } });
    const s = await loginAs(ctx, "operator");
    await createService(ctx, s);
    const c = await createCampaign(ctx, s, { rows: leadRows(1), payload: { approvalMode: "auto" } });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(ctx.ses.sent).toHaveLength(0);
    const [email] = await ctx.db.select().from(emails).where(eq(emails.campaignId, c.id));
    expect(email.status).toBe("queued");
    expect(email.scheduledFor!.getTime()).toBeGreaterThan(Date.now());
    const [lead] = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    expect(lead.status).toBe("scheduled");
    const pending = ctx.queue.pendingJobs();
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe(JOB_QUEUES.send);
    expect(pending[0].runAt).toBe(email.scheduledFor!.getTime());
  });

  it("enforces the daily cap and reschedules the overflow to the next day", async () => {
    await putSettings({ dailyCap: 1 });
    const s = await loginAs(ctx, "operator");
    await createService(ctx, s);
    const c = await createCampaign(ctx, s, { rows: leadRows(2), payload: { approvalMode: "auto" } });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(ctx.ses.sent).toHaveLength(1);
    const rows = await ctx.db.select().from(emails).where(eq(emails.campaignId, c.id));
    expect(rows.map((r) => r.status).sort()).toEqual(["queued", "sent"]);
    const queued = rows.find((r) => r.status === "queued")!;
    expect(queued.scheduledFor!.toISOString()).toMatch(/T00:05:00\.000Z$/);
    expect(ctx.metrics.totals.send_rate_limited).toBe(1);
    const status = json(await req(ctx, s, { method: "GET", url: "/api/system/status" }));
    expect(status.sentToday).toBe(1);
    expect(status.dailyCap).toBe(1);
  });

  it("cancels sends to addresses suppressed after drafting", async () => {
    const s = await loginAs(ctx, "operator");
    await createService(ctx, s);
    const c = await createCampaign(ctx, s, { rows: leadRows(1) });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    const [email] = await ctx.db.select().from(emails).where(eq(emails.campaignId, c.id));
    await req(ctx, s, { method: "POST", url: "/api/suppressions", payload: { email: "lead1@gmail.com", reason: "manual" } });
    await req(ctx, s, { method: "POST", url: `/api/emails/${email.id}/approve`, payload: {} });
    await ctx.queue.drain();
    expect(ctx.ses.sent).toHaveLength(0);
    const [lead] = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    expect(lead.status).toBe("suppressed");
  });

  it("records permanent SES failures without retrying", async () => {
    const s = await loginAs(ctx, "operator");
    await createService(ctx, s);
    const c = await createCampaign(ctx, s, { rows: [["F", "L", "fail@gmail.com", "X", "", "", "", "", ""]], payload: { approvalMode: "auto" } });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(ctx.queue.failures).toEqual([]); // permanent errors do not throw
    const [email] = await ctx.db.select().from(emails).where(eq(emails.campaignId, c.id));
    expect(email.status).toBe("failed");
    expect(email.error).toContain("MessageRejected");
    const detail = json(await req(ctx, s, { method: "GET", url: `/api/emails/${email.id}` }));
    expect(detail.attempts[0].error.name).toBe("MessageRejected");
    expect(ctx.metrics.totals.send_failures).toBe(1);
  });

  it("send-test uses the SES gateway with a [TEST] subject", async () => {
    const s = await loginAs(ctx, "operator");
    const c = await createCampaign(ctx, s, { rows: leadRows(1) });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    const [email] = await ctx.db.select().from(emails).where(eq(emails.campaignId, c.id));
    const r = await req(ctx, s, { method: "POST", url: `/api/emails/${email.id}/send-test`, payload: { to: "me@ours.com" } });
    expect(r.statusCode).toBe(200);
    expect(ctx.ses.sent[0].subject).toMatch(/^\[TEST\]/);
    expect(ctx.ses.sent[0].to).toBe("me@ours.com");
  });
});

describe("settings", () => {
  it("only admins can update; campaign overrides merge into hard rules", async () => {
    const op = await loginAs(ctx, "operator");
    const s = json(await req(ctx, op, { method: "GET", url: "/api/settings" })).settings;
    expect((await req(ctx, op, { method: "PUT", url: "/api/settings", payload: s })).statusCode).toBe(403);
    await putSettings({ hardRules: { ...DEFAULT_SETTINGS.hardRules, maxWords: 99 } });
    const rules = await ctx.settings.effectiveHardRules({ bannedPhrases: ["synergy"] });
    expect(rules.maxWords).toBe(99);
    expect(rules.bannedPhrases).toEqual(["synergy"]);
    const bad = await req(ctx, await loginAs(ctx, "admin", "admin2@test.local"), { method: "PUT", url: "/api/settings", payload: { ...s, dailyCap: -1 } });
    expect(json(bad).error.code).toBe("validation_error");
  });
});
