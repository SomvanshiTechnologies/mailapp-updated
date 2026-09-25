import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { JOB_QUEUES } from "@mailapp/shared";
import { createTestContext, json, loginAs, req, type TestContext } from "../helpers/context.js";
import { createCampaign, multipart, xlsxBuffer } from "../helpers/fixtures.js";
import { emails, leads } from "../../src/db/schema.js";
import { loadInstructionBundle } from "../../src/modules/instructions/service.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => ctx.reset());

describe("campaign access control", () => {
  it("operators only see their own campaigns until an admin grants access", async () => {
    const admin = await loginAs(ctx, "admin");
    const alice = await loginAs(ctx, "operator", "alice@test.local");
    const bob = await loginAs(ctx, "operator", "bob@test.local");
    const c = await createCampaign(ctx, alice);

    // Bob cannot see or act on Alice's campaign.
    expect(json(await req(ctx, bob, { method: "GET", url: "/api/campaigns" })).items).toHaveLength(0);
    expect((await req(ctx, bob, { method: "GET", url: `/api/campaigns/${c.id}` })).statusCode).toBe(404);
    expect((await req(ctx, bob, { method: "POST", url: `/api/campaigns/${c.id}/start` })).statusCode).toBe(404);
    // Admin sees everything and can control it.
    expect(json(await req(ctx, admin, { method: "GET", url: "/api/campaigns" })).items).toHaveLength(1);
    expect(json(await req(ctx, admin, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign.myAccess).toBe("full");
    expect(json(await req(ctx, admin, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign.createdByName).toBe("operator");

    // Bob cannot grant himself access.
    expect((await req(ctx, bob, { method: "PUT", url: `/api/campaigns/${c.id}/access`, payload: { userId: bob.user.id, level: "full" } })).statusCode).toBe(403);

    // View access: read but no actions.
    let r = await req(ctx, admin, { method: "PUT", url: `/api/campaigns/${c.id}/access`, payload: { userId: bob.user.id, level: "view" } });
    expect(r.statusCode).toBe(200);
    expect(json(r).items[0]).toMatchObject({ userId: bob.user.id, level: "view", userEmail: "bob@test.local" });
    expect(json(await req(ctx, bob, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign.myAccess).toBe("view");
    expect((await req(ctx, bob, { method: "GET", url: `/api/campaigns/${c.id}/leads` })).statusCode).toBe(200);
    expect((await req(ctx, bob, { method: "POST", url: `/api/campaigns/${c.id}/start` })).statusCode).toBe(403);
    expect((await req(ctx, bob, { method: "POST", url: `/api/campaigns/${c.id}/approve-all` })).statusCode).toBe(403);

    // Edit access: review actions but no lifecycle changes.
    await req(ctx, admin, { method: "PUT", url: `/api/campaigns/${c.id}/access`, payload: { userId: bob.user.id, level: "edit" } });
    expect((await req(ctx, bob, { method: "POST", url: `/api/campaigns/${c.id}/approve-all` })).statusCode).toBe(200);
    expect((await req(ctx, bob, { method: "POST", url: `/api/campaigns/${c.id}/start` })).statusCode).toBe(403);

    // Full access: same as the owner.
    await req(ctx, admin, { method: "PUT", url: `/api/campaigns/${c.id}/access`, payload: { userId: bob.user.id, level: "full" } });
    r = await req(ctx, bob, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    expect(r.statusCode).toBe(200);
    expect(json(r).campaign.status).toBe("active");

    // Revoke → invisible again.
    r = await req(ctx, admin, { method: "DELETE", url: `/api/campaigns/${c.id}/access/${bob.user.id}` });
    expect(json(r).items).toHaveLength(0);
    expect((await req(ctx, bob, { method: "GET", url: `/api/campaigns/${c.id}` })).statusCode).toBe(404);

    // Viewers are capped at view even when granted more.
    const viewer = await loginAs(ctx, "viewer");
    await req(ctx, admin, { method: "PUT", url: `/api/campaigns/${c.id}/access`, payload: { userId: viewer.user.id, level: "full" } });
    expect(json(await req(ctx, viewer, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign.myAccess).toBe("view");
  });

  it("locks campaign settings once started and scopes the review queue and analytics", async () => {
    const admin = await loginAs(ctx, "admin");
    const alice = await loginAs(ctx, "operator", "alice@test.local");
    const bob = await loginAs(ctx, "operator", "bob@test.local");
    const c = await createCampaign(ctx, alice, { payload: { name: "Alice campaign" } });
    // Draft: editable by the owner.
    let r = await req(ctx, alice, { method: "PATCH", url: `/api/campaigns/${c.id}`, payload: { name: "Renamed" } });
    expect(r.statusCode).toBe(200);
    expect(json(r).campaign.name).toBe("Renamed");
    await req(ctx, alice, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    r = await req(ctx, alice, { method: "PATCH", url: `/api/campaigns/${c.id}`, payload: { name: "Again" } });
    expect(r.statusCode).toBe(409);
    r = await req(ctx, admin, { method: "PATCH", url: `/api/campaigns/${c.id}`, payload: { name: "Again" } });
    expect(r.statusCode).toBe(409);

    // Run the pipeline so there is something in the review queue.
    await ctx.queue.drain();
    const pending = json(await req(ctx, alice, { method: "GET", url: "/api/emails", query: { status: "pending_review" } }));
    expect(pending.total).toBeGreaterThan(0);
    expect(json(await req(ctx, bob, { method: "GET", url: "/api/emails", query: { status: "pending_review" } })).total).toBe(0);
    expect((await req(ctx, bob, { method: "POST", url: `/api/emails/${pending.items[0].id}/approve` })).statusCode).toBe(404);
    expect((await req(ctx, bob, { method: "GET", url: `/api/leads/${pending.items[0].leadId}` })).statusCode).toBe(404);

    // Analytics: Bob sees nothing, Alice sees her leads, admin sees all; a dashboard-scope
    // grant lets Bob see everything without campaign access.
    expect(json(await req(ctx, bob, { method: "GET", url: "/api/analytics/overview" })).totals.leads).toBe(0);
    expect(json(await req(ctx, alice, { method: "GET", url: "/api/analytics/overview" })).totals.leads).toBe(3);
    expect(json(await req(ctx, admin, { method: "GET", url: "/api/analytics/overview" })).byCampaign).toHaveLength(1);
    await req(ctx, admin, { method: "PATCH", url: `/api/users/${bob.user.id}`, payload: { dashboardScope: "all" } });
    expect(json(await req(ctx, bob, { method: "GET", url: "/api/analytics/overview" })).totals.leads).toBe(3);
    expect(json(await req(ctx, bob, { method: "GET", url: "/api/campaigns" })).items).toHaveLength(0);
  });
});

describe("per-user sender profile and instructions", () => {
  it("uses the campaign owner's sender identity and personal docs, falling back to org settings", async () => {
    const admin = await loginAs(ctx, "admin");
    const alice = await loginAs(ctx, "operator", "alice@test.local");
    // Org docs + Alice's personal signature.
    await req(ctx, admin, { method: "POST", url: "/api/instructions", payload: { scope: "org", kind: "signature", title: "Org sig", content: "Regards,\nThe Team" } });
    await req(ctx, admin, { method: "POST", url: "/api/instructions", payload: { scope: "org", kind: "tone", title: "Org tone", content: "Warm." } });
    let r = await req(ctx, alice, { method: "POST", url: "/api/instructions", payload: { scope: "mine", kind: "signature", title: "My sig", content: "Cheers,\nAlice" } });
    expect(r.statusCode).toBe(200);
    expect(json(r).instruction.ownerId).toBe(alice.user.id);
    // Operators cannot touch org docs.
    expect((await req(ctx, alice, { method: "POST", url: "/api/instructions", payload: { scope: "org", kind: "tone", title: "x", content: "y" } })).statusCode).toBe(403);
    const orgDoc = json(await req(ctx, alice, { method: "GET", url: "/api/instructions", query: { scope: "org" } })).items[0];
    expect((await req(ctx, alice, { method: "DELETE", url: `/api/instructions/${orgDoc.id}` })).statusCode).toBe(403);
    const mine = json(await req(ctx, alice, { method: "GET", url: "/api/instructions", query: { scope: "mine" } }));
    expect(mine.items).toHaveLength(1);
    expect(mine.personalisedKinds).toEqual(["signature"]);

    const bundle = await loadInstructionBundle(ctx.db, alice.user.id);
    expect(bundle.signature).toBe("Cheers,\nAlice");
    expect(bundle.tone).toBe("Warm.");
    expect((await loadInstructionBundle(ctx.db)).signature).toBe("Regards,\nThe Team");

    // Alice's sender profile (domain of the org from-address is "verified" in mock mode).
    r = await req(ctx, alice, { method: "PATCH", url: "/api/auth/me", payload: { fromEmail: "alice@example.com", fromName: "Alice A", replyTo: "alice@example.com" } });
    expect(r.statusCode).toBe(200);
    expect(json(r).user.fromEmail).toBe("alice@example.com");
    // Unverified domains are refused.
    r = await req(ctx, alice, { method: "PATCH", url: "/api/auth/me", payload: { fromEmail: "alice@elsewhere.org" } });
    expect(r.statusCode).toBe(400);
    expect(json(r).error.message).toMatch(/not a verified SES identity/);

    // Personal delivery mode with tracking off → text-only, no bulk headers, Alice's identity.
    await req(ctx, admin, { method: "PUT", url: "/api/settings", payload: { ...json(await req(ctx, admin, { method: "GET", url: "/api/settings" })).settings, deliveryMode: "personal", trackOpens: false, updatedAt: undefined } });
    const c = await createCampaign(ctx, alice, { payload: { approvalMode: "auto" } });
    await req(ctx, alice, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(ctx.ses.sent.length).toBe(3);
    const sent = ctx.ses.sent[0];
    expect(sent.from).toBe("alice@example.com");
    expect(sent.fromName).toBe("Alice A");
    expect(sent.html).toBeNull();
    expect(sent.headers["List-Unsubscribe"]).toBeUndefined();
    expect(sent.text).toContain("Cheers,\nAlice");
    expect(sent.text).toContain("just reply and let me know");
    const [row] = await ctx.db.select().from(emails).where(eq(emails.id, (await ctx.db.select().from(emails).limit(1))[0].id));
    expect(row.senderUserId).toBe(alice.user.id);

    // Bulk mode with tracking → html + headers.
    await req(ctx, admin, { method: "PUT", url: "/api/settings", payload: { ...json(await req(ctx, admin, { method: "GET", url: "/api/settings" })).settings, deliveryMode: "bulk", trackOpens: true, updatedAt: undefined } });
    const c2 = await createCampaign(ctx, admin, { payload: { approvalMode: "auto", name: "Admin campaign" }, rows: [["Zed", "Z", "zed@gmail.com", "Zed Co", "", "CEO", "Tech", "", ""]] });
    await req(ctx, admin, { method: "POST", url: `/api/campaigns/${c2.id}/start` });
    await ctx.queue.drain();
    const last = ctx.ses.sent.at(-1)!;
    expect(last.from).toBe("outreach@example.com");
    expect(last.html).toContain("<!doctype html>");
    expect(last.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("admin user management", () => {
  it("reports per-user send stats, stops a user's sending and deletes users safely", async () => {
    const admin = await loginAs(ctx, "admin");
    const alice = await loginAs(ctx, "operator", "alice@test.local");
    const c = await createCampaign(ctx, alice, { payload: { approvalMode: "auto" } });
    await req(ctx, alice, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(ctx.ses.sent.length).toBe(3);

    let r = await req(ctx, admin, { method: "GET", url: "/api/users/stats" });
    expect(r.statusCode).toBe(200);
    const stats = json(r).items.find((s: { userId: string }) => s.userId === alice.user.id);
    expect(stats).toMatchObject({ campaigns: 1, activeCampaigns: 1, sentTotal: 3, sentToday: 3, sentLast7Days: 3, pendingSend: 0 });
    expect((await req(ctx, alice, { method: "GET", url: "/api/users/stats" })).statusCode).toBe(403);

    // Stop sending: active campaigns paused, an approved email stays put.
    const [lead] = await ctx.db.select().from(leads).limit(1);
    const [queued] = await ctx.db.insert(emails).values({ leadId: lead.id, campaignId: c.id, step: 2, toEmail: lead.email, subject: "s", bodyText: "b", status: "approved" }).returning();
    r = await req(ctx, admin, { method: "POST", url: `/api/users/${alice.user.id}/stop-sending` });
    expect(json(r).pausedCampaigns).toBe(1);
    expect(json(await req(ctx, admin, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign.status).toBe("paused");
    await ctx.queue.publish(JOB_QUEUES.send, { emailId: queued.id }, { singletonKey: `send:${queued.id}:x` });
    await ctx.queue.drain();
    expect(ctx.ses.sent.length).toBe(3);

    // Guard rails, then delete: campaign survives without an owner, personal docs go.
    await req(ctx, alice, { method: "POST", url: "/api/instructions", payload: { scope: "mine", kind: "tone", title: "t", content: "c" } });
    expect((await req(ctx, admin, { method: "DELETE", url: `/api/users/${admin.user.id}` })).statusCode).toBe(400);
    r = await req(ctx, admin, { method: "DELETE", url: `/api/users/${alice.user.id}` });
    expect(r.statusCode).toBe(200);
    expect(json(await req(ctx, admin, { method: "GET", url: "/api/users" })).items.map((u: { email: string }) => u.email)).not.toContain("alice@test.local");
    expect(json(await req(ctx, admin, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign.createdBy).toBeNull();
    expect((await req(ctx, alice, { method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    const admins = json(await req(ctx, admin, { method: "GET", url: "/api/users" })).items;
    expect(admins).toHaveLength(1);
  });

  it("shows when queued emails will go out", async () => {
    const admin = await loginAs(ctx, "admin");
    const c = await createCampaign(ctx, admin, { rows: [["Ann", "A", "ann@gmail.com", "Ann Co", "", "COO", "Retail", "", ""]] });
    const [lead] = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    const when = new Date(Date.now() + 3 * 3_600_000);
    await ctx.db.insert(emails).values({ leadId: lead.id, campaignId: c.id, step: 1, toEmail: lead.email, subject: "s", bodyText: "b", status: "queued", scheduledFor: when });
    const list = json(await req(ctx, admin, { method: "GET", url: `/api/campaigns/${c.id}/leads` }));
    expect(list.items[0].nextSendAt).toBe(when.toISOString());
    const detail = json(await req(ctx, admin, { method: "GET", url: `/api/leads/${lead.id}` }));
    expect(detail.lead.nextSendAt).toBe(when.toISOString());
    expect(detail.lead.emails[0].scheduledFor).toBe(when.toISOString());
  });
});

describe("xlsx exports and imports", () => {
  it("exports suppressions and settings and re-imports instructions", async () => {
    const admin = await loginAs(ctx, "admin");
    await req(ctx, admin, { method: "POST", url: "/api/suppressions", payload: { email: "gone@example.com", reason: "manual", note: "left company" } });
    let r = await req(ctx, admin, { method: "GET", url: "/api/suppressions/export" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml");
    let wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    const supp = wb.getWorksheet("Suppressions")!;
    expect(supp.getRow(2).getCell(1).text).toBe("gone@example.com");

    await req(ctx, admin, { method: "POST", url: "/api/instructions", payload: { scope: "org", kind: "tone", title: "Org tone", content: "Warm and direct." } });
    r = await req(ctx, admin, { method: "GET", url: "/api/settings/export" });
    expect(r.statusCode).toBe(200);
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Settings", "HardRules", "Instructions", "Services"]);
    const docs = wb.getWorksheet("Instructions")!;
    expect(docs.getRow(2).getCell(2).text).toBe("tone");
    expect(docs.getRow(2).getCell(6).text).toBe("Warm and direct.");

    // Another user imports that workbook as personal docs.
    const bob = await loginAs(ctx, "operator", "bob@test.local");
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const mp = multipart({ file: { buffer: buf, filename: "settings.xlsx" }, fields: { scope: "mine" } });
    r = await req(ctx, bob, { method: "POST", url: "/api/instructions/import", payload: mp.payload, headers: mp.headers });
    expect(r.statusCode).toBe(200);
    expect(json(r).imported).toBe(1);
    const mine = json(await req(ctx, bob, { method: "GET", url: "/api/instructions", query: { scope: "mine" } }));
    expect(mine.items[0]).toMatchObject({ kind: "tone", title: "Org tone", ownerId: bob.user.id });

    // A plain sheet with kind/title/content also works.
    const plain = await xlsxBuffer(["kind", "title", "content"], [["signature", "Sig", "Bye"], ["bogus", "x", "y"]], "Sheet1");
    const mp2 = multipart({ file: { buffer: plain, filename: "docs.xlsx" }, fields: { scope: "mine" } });
    r = await req(ctx, bob, { method: "POST", url: "/api/instructions/import", payload: mp2.payload, headers: mp2.headers });
    expect(json(r)).toMatchObject({ imported: 1 });
    expect(json(r).skipped[0].reason).toMatch(/unknown kind/);
  });
});
