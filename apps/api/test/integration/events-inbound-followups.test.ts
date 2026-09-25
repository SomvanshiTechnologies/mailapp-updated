import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { JOB_QUEUES } from "@mailapp/shared";
import { createTestContext, json, loginAs, req, type TestContext, type Session } from "../helpers/context.js";
import { createCampaign, createService, leadRows, rawEmail, sesEvent, snsNotification } from "../helpers/fixtures.js";
import { emails, leads, suppressions, campaigns } from "../../src/db/schema.js";
import { runFollowupTick } from "../../src/modules/followups/scheduler.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => ctx.reset());

/** Create, start and fully send one auto-mode campaign; returns the sent email + lead. */
async function sendOne(s: Session, extraRows: Array<Array<string | number | null>> = []) {
  await createService(ctx, s);
  const c = await createCampaign(ctx, s, { rows: [...leadRows(1), ...extraRows], payload: { approvalMode: "auto" } });
  await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
  await ctx.queue.drain();
  const [email] = await ctx.db.select().from(emails).where(eq(emails.campaignId, c.id));
  const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, email.leadId));
  return { campaign: c, email, lead };
}

async function postEvent(payload: unknown, path = "/webhooks/ses/events") {
  return ctx.app.inject({ method: "POST", url: path, payload: snsNotification(payload), headers: { "content-type": "text/plain" } });
}

describe("SES event webhook", () => {
  it("confirms SNS subscriptions via SubscribeURL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/ses/events",
      payload: { Type: "SubscriptionConfirmation", MessageId: "m", TopicArn: "arn:aws:sns:us-east-1:1:t", Message: "", Timestamp: "", SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc" },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).confirmed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("ConfirmSubscription"));
    const evil = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/ses/events",
      payload: { Type: "SubscriptionConfirmation", MessageId: "m", TopicArn: "arn:aws:sns:us-east-1:1:t", Message: "", Timestamp: "", SubscribeURL: "https://evil.example.com/steal" },
    });
    expect(evil.statusCode).toBe(403);
    fetchSpy.mockRestore();
  });

  it("applies Delivery/Open/Click and dedupes repeats", async () => {
    const s = await loginAs(ctx, "operator");
    const { email, lead } = await sendOne(s);
    const id = email.sesMessageId!;
    const ts = new Date().toISOString();
    expect(json(await postEvent(sesEvent("Delivery", id, { delivery: { timestamp: ts } })))).toMatchObject({ stored: true, matched: true });
    expect(json(await postEvent(sesEvent("Delivery", id, { delivery: { timestamp: ts } })))).toMatchObject({ duplicate: true });
    await postEvent(sesEvent("Open", id, { open: { timestamp: ts } }));
    await postEvent(sesEvent("Click", id, { click: { timestamp: ts, link: "https://example.com" } }));
    const detail = json(await req(ctx, s, { method: "GET", url: `/api/leads/${lead.id}` })).lead;
    expect(detail.status).toBe("clicked");
    expect(detail.deliveredAt).toBeTruthy();
    expect(detail.openedAt).toBeTruthy();
    expect(detail.events.map((e: { eventType: string }) => e.eventType).sort()).toEqual(["Click", "Delivery", "Open"]);
    // Late Delivery event must not downgrade status.
    await postEvent(sesEvent("Delivery", id, { delivery: { timestamp: new Date(Date.now() + 1000).toISOString() } }));
    expect(json(await req(ctx, s, { method: "GET", url: `/api/leads/${lead.id}` })).lead.status).toBe("clicked");
    const events = json(await req(ctx, s, { method: "GET", url: `/api/analytics/events?type=Open` }));
    expect(events.total).toBe(1);
  });

  it("hard bounce suppresses the address and stops the sequence; soft bounce only annotates", async () => {
    const s = await loginAs(ctx, "operator");
    const { email, lead } = await sendOne(s);
    const id = email.sesMessageId!;
    await postEvent(sesEvent("Bounce", id, { bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", timestamp: new Date().toISOString() } }));
    let [l] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.status).toBe("sent");
    expect(l.lastError).toContain("soft bounce");
    await postEvent(sesEvent("Bounce", id, { bounce: { bounceType: "Permanent", bounceSubType: "General", timestamp: new Date(Date.now() + 5).toISOString(), bouncedRecipients: [{ emailAddress: lead.email, diagnosticCode: "550 no such user" }] } }));
    [l] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.status).toBe("bounced");
    expect(l.nextActionAt).toBeNull();
    const [sup] = await ctx.db.select().from(suppressions).where(eq(suppressions.email, lead.email));
    expect(sup.reason).toBe("hard_bounce");
    expect(ctx.ses.suppressed.get(lead.email)?.reason).toBe("BOUNCE");
    expect(ctx.metrics.totals.bounces).toBe(2);
  });

  it("complaint and reject events", async () => {
    const s = await loginAs(ctx, "operator");
    const { email, lead } = await sendOne(s);
    await postEvent(sesEvent("Complaint", email.sesMessageId!, { complaint: { complaintFeedbackType: "abuse", timestamp: new Date().toISOString() } }));
    const [l] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.status).toBe("complained");
    expect((await ctx.db.select().from(suppressions))[0].reason).toBe("complaint");
    const unknown = json(await postEvent(sesEvent("Reject", "does-not-exist", { reject: { reason: "Bad content" } })));
    expect(unknown).toMatchObject({ stored: true, matched: false });
    const bad = await postEvent({ foo: "bar" });
    expect(json(bad)).toMatchObject({ ok: true, stored: false });
  });

  it("rejects messages from unexpected topics when an allow-list is configured", async () => {
    const strict = await createTestContext({ SNS_ALLOWED_TOPIC_ARNS: "arn:aws:sns:us-east-1:123456789012:allowed" });
    try {
      const res = await strict.app.inject({ method: "POST", url: "/webhooks/ses/events", payload: snsNotification({ eventType: "Send" }, "arn:aws:sns:us-east-1:123456789012:other") });
      expect(res.statusCode).toBe(403);
      expect(strict.metrics.totals.webhook_signature_failures).toBe(1);
    } finally {
      await strict.close();
      // restore the shared ctx config as the active one
      const { setConfigForTests } = await import("../../src/config.js");
      setConfigForTests(ctx.config);
    }
  });
});

describe("inbound replies", () => {
  it("matches a reply by In-Reply-To, stores the thread and stops follow-ups", async () => {
    const s = await loginAs(ctx, "operator");
    const { email, lead } = await sendOne(s);
    const raw = rawEmail({ from: `Lead One <${lead.email}>`, to: "replies@example.com", subject: `Re: ${email.subject}`, text: "Yes, let's talk on Tuesday.", inReplyTo: email.messageIdHeader! });
    const res = await postEvent({ notificationType: "Received", mail: { messageId: "inb-1", source: lead.email }, receipt: { action: { type: "SNS" } }, content: Buffer.from(raw).toString("base64") }, "/webhooks/ses/inbound");
    expect(json(res)).toMatchObject({ stored: true, matched: true, method: "message-id", autoReply: false });
    const detail = json(await req(ctx, s, { method: "GET", url: `/api/leads/${lead.id}` })).lead;
    expect(detail.status).toBe("replied");
    expect(detail.repliedAt).toBeTruthy();
    expect(detail.nextActionAt).toBeNull();
    expect(detail.emails.map((e: { direction: string }) => e.direction)).toEqual(["outbound", "inbound"]);
    expect(detail.emails[1].bodyText).toContain("Tuesday");
    // duplicate delivery is ignored
    const dup = await postEvent({ notificationType: "Received", mail: { messageId: "inb-1" }, content: Buffer.from(raw).toString("base64") }, "/webhooks/ses/inbound");
    expect(json(dup).duplicate).toBe(true);
    expect(ctx.metrics.totals.replies).toBe(1);
  });

  it("falls back to sender address and ignores auto-replies", async () => {
    const s = await loginAs(ctx, "operator");
    const { lead } = await sendOne(s);
    const ooo = rawEmail({ from: lead.email, to: "replies@example.com", subject: "Automatic reply: out of office", text: "Back next week" });
    const r1 = json(await postEvent({ notificationType: "Received", mail: { messageId: "inb-ooo" }, content: Buffer.from(ooo).toString("base64") }, "/webhooks/ses/inbound"));
    expect(r1).toMatchObject({ matched: true, method: "sender-address", autoReply: true });
    let [l] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.status).toBe("sent");
    const real = rawEmail({ from: lead.email, to: "replies@example.com", subject: "hello", text: "Interested" });
    await postEvent({ notificationType: "Received", mail: { messageId: "inb-real" }, content: Buffer.from(real).toString("base64") }, "/webhooks/ses/inbound");
    [l] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.status).toBe("replied");
    const stranger = rawEmail({ from: "stranger@nowhere.test", to: "replies@example.com", subject: "hi", text: "?" });
    const r3 = json(await postEvent({ notificationType: "Received", mail: { messageId: "inb-x" }, content: Buffer.from(stranger).toString("base64") }, "/webhooks/ses/inbound"));
    expect(r3.matched).toBe(false);
    const spam = json(await postEvent({ notificationType: "Received", mail: { messageId: "inb-spam" }, receipt: { spamVerdict: { status: "FAIL" } }, content: "x" }, "/webhooks/ses/inbound"));
    expect(spam.stored).toBe(false);
  });

  it("manual mark-replied and unsubscribe actions", async () => {
    const s = await loginAs(ctx, "operator");
    const { lead } = await sendOne(s);
    const r = await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/mark-replied`, payload: { note: "phoned" } });
    expect(json(r).lead.status).toBe("replied");
    const u = await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/unsubscribe` });
    expect(json(u).lead.status).toBe("unsubscribed");
    expect((await ctx.db.select().from(suppressions)).map((x) => x.reason)).toEqual(["unsubscribe"]);
  });
});

describe("follow-ups", () => {
  it("schedules threaded follow-ups, completes the sequence and the campaign", async () => {
    const s = await loginAs(ctx, "operator");
    const { campaign, email, lead } = await sendOne(s);
    let [l] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    const expectedNext = new Date(email.sentAt!.getTime() + 3 * 86_400_000);
    expect(Math.abs(l.nextActionAt!.getTime() - expectedNext.getTime())).toBeLessThan(5000);

    // Nothing due yet.
    expect(await runFollowupTick(ctx, new Date())).toEqual({ scheduled: 0, completed: 0 });
    // Three days later: step 2 is drafted, auto-approved and sent, threaded on the first message.
    const day3 = new Date(Date.now() + 3 * 86_400_000 + 60_000);
    expect(await runFollowupTick(ctx, day3)).toEqual({ scheduled: 1, completed: 0 });
    expect(ctx.queue.pendingJobs().map((j) => j.name)).toEqual([JOB_QUEUES.draft]);
    await ctx.queue.drain();
    expect(ctx.queue.failures.map((f) => String((f.error as Error).stack ?? f.error))).toEqual([]);
    const allEmails = await ctx.db.select().from(emails).where(eq(emails.leadId, lead.id));
    expect(allEmails.map((e) => `${e.step}:${e.status}:${e.validation?.issues.map((i) => i.rule).join(",")}`)).toEqual(["1:sent:", "2:sent:"]);
    expect(ctx.ses.sent).toHaveLength(2);
    const second = ctx.ses.sent[1];
    expect(second.subject).toMatch(/^Re: /);
    expect(second.headers["In-Reply-To"]).toBe(email.messageIdHeader);
    expect(second.headers["References"]).toContain(email.messageIdHeader!);
    [l] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.currentStep).toBe(2);
    expect(l.status).toBe("sent");

    // Step 3 (5 days after step 2), then no more steps -> completed.
    const day9 = new Date(Date.now() + 9 * 86_400_000);
    expect((await runFollowupTick(ctx, day9)).scheduled).toBe(1);
    await ctx.queue.drain();
    expect(ctx.ses.sent).toHaveLength(3);
    [l] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.currentStep).toBe(3);
    expect(l.nextActionAt).toBeNull(); // last step: nothing further
    // The completion sweep marks the lead + campaign completed once the sequence is exhausted.
    await runFollowupTick(ctx, new Date(Date.now() + 30 * 86_400_000));
    const [c] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(c.status).toBe("completed");
    expect(ctx.metrics.totals.followups_scheduled).toBe(2);
  });

  it("does not follow up leads that replied, bounced or unsubscribed", async () => {
    const s = await loginAs(ctx, "operator");
    const { lead } = await sendOne(s);
    await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/mark-replied`, payload: {} });
    const r = await runFollowupTick(ctx, new Date(Date.now() + 10 * 86_400_000));
    expect(r.scheduled).toBe(0);
    expect(ctx.queue.pendingJobs()).toEqual([]);
  });
});
