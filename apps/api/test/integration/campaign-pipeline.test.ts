import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { JOB_QUEUES } from "@mailapp/shared";
import { createTestContext, json, loginAs, req, type TestContext } from "../helpers/context.js";
import { LEAD_HEADERS, createCampaign, createService, leadRows, multipart, xlsxBuffer } from "../helpers/fixtures.js";
import { emails, leads } from "../../src/db/schema.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => ctx.reset());

describe("campaign import", () => {
  it("previews a sheet", async () => {
    const s = await loginAs(ctx, "operator");
    const buffer = await xlsxBuffer(LEAD_HEADERS, leadRows(2));
    const mp = multipart({ file: { buffer, filename: "leads.xlsx" } });
    const res = await req(ctx, s, { method: "POST", url: "/api/campaigns/preview", payload: mp.payload, headers: mp.headers });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.mapped.Email).toBe("email");
    expect(body.unmapped).toEqual(["Account Owner"]);
    expect(body.totalRows).toBe(2);
    expect(body.sampleRows[0]["First Name"]).toBe("Lead1");
  });

  it("creates a campaign with leads, skipping suppressed and invalid rows", async () => {
    const s = await loginAs(ctx, "operator");
    await req(ctx, s, { method: "POST", url: "/api/suppressions", payload: { email: "lead2@gmail.com", reason: "manual" } });
    const rows = [...leadRows(3), ["Bad", "Row", "not-an-email", "X", "", "", "", "", ""]];
    const c = await createCampaign(ctx, s, { rows });
    expect(c.importSummary).toMatchObject({ totalRows: 4, imported: 2, suppressed: 1, invalidEmails: 1, duplicatesInSheet: 0 });
    expect(c.counts.total).toBe(3);
    const list = await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}/leads?status=suppressed` });
    expect(json(list).items[0].email).toBe("lead2@gmail.com");
    const extra = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}/leads?search=lead1` })).items[0];
    expect(extra.extra).toEqual({ "Account Owner": "owner@ours.com" });
    expect(extra.status).toBe("pending");
  });

  it("rejects sheets without an email column and bad payloads", async () => {
    const s = await loginAs(ctx, "operator");
    const buffer = await xlsxBuffer(["Name", "Company"], [["A", "B"]]);
    const mp = multipart({ file: { buffer, filename: "leads.xlsx" }, fields: { payload: JSON.stringify({ name: "x" }) } });
    const res = await req(ctx, s, { method: "POST", url: "/api/campaigns", payload: mp.payload, headers: mp.headers });
    expect(res.statusCode).toBe(400);
    expect(json(res).error.message).toMatch(/email/);
    const badType = multipart({ file: { buffer: Buffer.from("x"), filename: "leads.exe" } });
    expect((await req(ctx, s, { method: "POST", url: "/api/campaigns", payload: badType.payload, headers: badType.headers })).statusCode).toBe(400);
    const badSeq = multipart({ file: { buffer: await xlsxBuffer(LEAD_HEADERS, leadRows(1)), filename: "l.xlsx" }, fields: { payload: JSON.stringify({ name: "x", sequence: [{ step: 1, delayDays: 2 }] }) } });
    const r = await req(ctx, s, { method: "POST", url: "/api/campaigns", payload: badSeq.payload, headers: badSeq.headers });
    expect(json(r).error.code).toBe("validation_error");
  });
});

describe("pipeline: research -> draft -> review -> send", () => {
  it("runs the manual-approval flow end to end with mock LLM and SES", async () => {
    const s = await loginAs(ctx, "operator");
    const service = await createService(ctx, s);
    const c = await createCampaign(ctx, s, { rows: leadRows(2), payload: { serviceIds: [service.id] } });

    const start = await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    expect(start.statusCode).toBe(200);
    expect(json(start).enqueued).toBe(2);
    expect(ctx.queue.published.filter((p) => p.name === JOB_QUEUES.research)).toHaveLength(2);

    await ctx.queue.drain();
    expect(ctx.queue.failures).toEqual([]);

    const campaign = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign;
    expect(campaign.status).toBe("active");
    expect(campaign.counts.pendingReview).toBe(2);

    const queue = json(await req(ctx, s, { method: "GET", url: `/api/emails?status=pending_review&campaignId=${c.id}` }));
    expect(queue.total).toBe(2);
    const draft = queue.items[0];
    expect(draft.validation.ok).toBe(true);
    expect(draft.lead.persona.companySummary).toContain("Company");
    expect(draft.lead.matchedServices[0].serviceName).toBe("Fleet Analytics");
    expect(draft.subject).toContain("Fleet Analytics");
    expect(draft.llmMeta.pitchAngle).toBeTruthy();

    // Approve with an edit.
    const approve = await req(ctx, s, { method: "POST", url: `/api/emails/${draft.id}/approve`, payload: { subject: "Edited subject", note: "tightened" } });
    expect(approve.statusCode).toBe(200);
    expect(json(approve).email.status).toBe("approved");
    expect(ctx.ses.sent).toHaveLength(0);

    await ctx.queue.drain();
    expect(ctx.queue.failures).toEqual([]);
    expect(ctx.ses.sent).toHaveLength(1);
    const sent = ctx.ses.sent[0];
    expect(sent.subject).toBe("Edited subject");
    expect(sent.to).toBe(draft.lead.email);
    // Default delivery mode is "personal": no bulk headers, opt-out link inline in the text.
    expect(sent.headers["List-Unsubscribe"]).toBeUndefined();
    expect(sent.text).toMatch(/Manage preferences: http:\/\/localhost:4000\/u\//);
    expect(sent.tags).toMatchObject({ campaign_id: c.id, lead_id: draft.leadId, step: "1" });
    expect(sent.text).toContain("Outreach Team");
    expect(sent.configurationSet).toBe("test-config-set");

    const detail = json(await req(ctx, s, { method: "GET", url: `/api/leads/${draft.leadId}` })).lead;
    expect(detail.status).toBe("sent");
    expect(detail.currentStep).toBe(1);
    expect(detail.nextActionAt).not.toBeNull(); // follow-up scheduled (default sequence step 2 = 3 days)
    expect(detail.emails[0].sesMessageId).toMatch(/^mock-/);
    expect(detail.emails[0].messageIdHeader).toMatch(/@email\.amazonses\.com>$/);
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0].response.MessageId).toBe(detail.emails[0].sesMessageId);

    // Reject the other.
    const other = queue.items[1];
    const reject = await req(ctx, s, { method: "POST", url: `/api/emails/${other.id}/reject`, payload: { note: "off-target" } });
    expect(json(reject).email.status).toBe("rejected");
    const stats = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}/stats` }));
    expect(stats.counts.sent).toBe(1);

    // Status export contains original headers + status columns.
    const exp = await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}/export` });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers["content-disposition"]).toMatch(/attachment/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exp.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Status")!;
    const headers = (ws.getRow(1).values as string[]).slice(1);
    expect(headers.slice(0, LEAD_HEADERS.length)).toEqual(LEAD_HEADERS);
    expect(headers).toEqual(expect.arrayContaining(["status", "ses_message_id", "sent_at", "matched_services"]));
    const rowsByEmail = new Map<string, Record<string, unknown>>();
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const rec: Record<string, unknown> = {};
      headers.forEach((h, i) => (rec[h] = row.getCell(i + 1).value));
      rowsByEmail.set(String(rec.Email), rec);
    });
    expect(rowsByEmail.get(draft.lead.email)).toMatchObject({ status: "sent", "Account Owner": "owner@ours.com" });
    expect(String(rowsByEmail.get(draft.lead.email)!.ses_message_id)).toMatch(/^mock-/);
    expect(rowsByEmail.get(other.lead.email)!.status).toBe("rejected");
  });

  it("auto mode sends without review, but validator failures still go to review", async () => {
    const s = await loginAs(ctx, "operator");
    await createService(ctx, s);
    const rows = [...leadRows(1), ["Long", "Draft", "long@gmail.com", "LongCo", "", "", "", "mock:long-draft", ""]];
    const c = await createCampaign(ctx, s, { rows, payload: { approvalMode: "auto" } });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(ctx.queue.failures).toEqual([]);
    expect(ctx.ses.sent).toHaveLength(2); // mock provider fixes the draft on the second attempt
    const all = await ctx.db.select().from(emails);
    const longDraft = all.find((e) => e.toEmail === "long@gmail.com")!;
    expect(longDraft.llmMeta).toMatchObject({ attempt: 2 });
    expect(ctx.metrics.totals.drafts_rejected_by_validator).toBe(1);
  });

  it("marks failures, exposes lastError and supports retry", async () => {
    const s = await loginAs(ctx, "operator");
    const rows = [["F", "R", "fail@gmail.com", "FailCo", "", "", "", "mock:fail-research", ""]];
    const c = await createCampaign(ctx, s, { rows });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(ctx.queue.failures).toHaveLength(1);
    const [lead] = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    expect(lead.status).toBe("failed");
    expect(lead.lastError).toContain("research");
    // Clear the flag and retry.
    await ctx.db.update(leads).set({ notes: "" }).where(eq(leads.id, lead.id));
    const retry = await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/retry` });
    expect(json(retry).lead.status).toBe("pending");
    await ctx.queue.drain();
    const [after] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after.status).toBe("pending_review");
  });

  it("pause stops processing and resume re-enqueues", async () => {
    const s = await loginAs(ctx, "operator");
    const c = await createCampaign(ctx, s, { rows: leadRows(1) });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/pause` });
    await ctx.queue.drain();
    let [lead] = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    expect(lead.status).toBe("pending");
    const resume = await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/resume` });
    expect(json(resume).campaign.status).toBe("active");
    await ctx.queue.drain();
    [lead] = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    expect(lead.status).toBe("pending_review");
    const del = await req(ctx, s, { method: "DELETE", url: `/api/campaigns/${c.id}` });
    expect(del.statusCode).toBe(403); // operator cannot delete
  });

  it("regenerates a draft with feedback and approve-all skips invalid drafts", async () => {
    const s = await loginAs(ctx, "operator");
    const rows = [...leadRows(1), ["B", "P", "banned@gmail.com", "BanCo", "", "", "", "mock:banned", ""]];
    const c = await createCampaign(ctx, s, { rows, payload: { hardRulesOverride: { bannedPhrases: ["limited time offer"] } } });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    const queue = json(await req(ctx, s, { method: "GET", url: `/api/emails?status=pending_review&campaignId=${c.id}` }));
    expect(queue.total).toBe(2);
    const first = queue.items.find((e: { toEmail: string }) => e.toEmail === "lead1@gmail.com");
    const regen = await req(ctx, s, { method: "POST", url: `/api/emails/${first.id}/regenerate`, payload: { feedback: "Shorter please" } });
    expect(json(regen).email.status).toBe("rejected");
    await ctx.queue.drain();
    const after = json(await req(ctx, s, { method: "GET", url: `/api/emails?status=pending_review&campaignId=${c.id}` }));
    const regenerated = after.items.find((e: { toEmail: string; id: string }) => e.toEmail === "lead1@gmail.com");
    expect(regenerated.id).not.toBe(first.id);
    expect(regenerated.llmMeta.regenerationFeedback).toBe("Shorter please");
    const approveAll = await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/approve-all` });
    expect(json(approveAll).approved).toBe(2); // banned draft was auto-fixed by the second attempt, so both are valid
    await ctx.queue.drain();
    expect(ctx.ses.sent).toHaveLength(2);
  });
});
