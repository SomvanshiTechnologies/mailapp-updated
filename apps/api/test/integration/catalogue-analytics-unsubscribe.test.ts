import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestContext, json, loginAs, req, type TestContext } from "../helpers/context.js";
import { createCampaign, createService, leadRows, multipart, sesEvent, snsNotification, xlsxBuffer } from "../helpers/fixtures.js";
import { emails, leads, suppressions } from "../../src/db/schema.js";
import { loadInstructionBundle } from "../../src/modules/instructions/service.js";
import { runSesSync } from "../../src/modules/ses/sync.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => ctx.reset());

describe("services", () => {
  it("CRUD + xlsx import with upsert", async () => {
    const s = await loginAs(ctx, "operator");
    const created = await createService(ctx, s, "Audit");
    const patched = await req(ctx, s, { method: "PATCH", url: `/api/services/${created.id}`, payload: { tags: ["finance"] } });
    expect(json(patched).service.tags).toEqual(["finance"]);
    const buffer = await xlsxBuffer(["Service", "Description", "Benefits"], [["Audit", "Updated description", "fast; cheap"], ["New One", "Brand new", ""]]);
    const mp = multipart({ file: { buffer, filename: "services.xlsx" } });
    const imp = await req(ctx, s, { method: "POST", url: "/api/services/import", payload: mp.payload, headers: mp.headers });
    expect(json(imp)).toMatchObject({ imported: 1, updated: 1, errors: [] });
    const list = json(await req(ctx, s, { method: "GET", url: "/api/services" })).items;
    expect(list.map((x: { name: string }) => x.name)).toEqual(["Audit", "New One"]);
    expect(list[0].description).toBe("Updated description");
    await req(ctx, s, { method: "DELETE", url: `/api/services/${created.id}` });
    expect(json(await req(ctx, s, { method: "GET", url: "/api/services" })).items).toHaveLength(1);
    expect(json(await req(ctx, s, { method: "GET", url: "/api/services?includeInactive=true" })).items).toHaveLength(2);
  });
});

describe("instructions", () => {
  it("versions documents, uploads text files and builds the bundle", async () => {
    // Organisation-wide documents are admin-managed (operators keep personal ones under scope=mine).
    const s = await loginAs(ctx, "admin");
    const v1 = json(await req(ctx, s, { method: "POST", url: "/api/instructions", payload: { kind: "tone", title: "Tone", content: "Be warm." } })).instruction;
    const v2 = json(await req(ctx, s, { method: "POST", url: "/api/instructions", payload: { kind: "tone", title: "Tone", content: "Be warmer." } })).instruction;
    expect(v2.version).toBe(2);
    const all = json(await req(ctx, s, { method: "GET", url: "/api/instructions?includeInactive=true&kind=tone" })).items;
    expect(all.find((i: { id: string }) => i.id === v1.id).isActive).toBe(false);
    const mp = multipart({ file: { buffer: Buffer.from("# Rules\nNo pricing."), filename: "rules.md" }, fields: { kind: "rules", title: "Rules" } });
    const up = await req(ctx, s, { method: "POST", url: "/api/instructions/upload", payload: mp.payload, headers: mp.headers });
    expect(up.statusCode).toBe(200);
    const bundle = await loadInstructionBundle(ctx.db);
    expect(bundle.tone).toBe("Be warmer.");
    expect(bundle.rules).toContain("No pricing.");
    const off = await req(ctx, s, { method: "PATCH", url: `/api/instructions/${v2.id}`, payload: { isActive: false } });
    expect(json(off).instruction.isActive).toBe(false);
    expect((await loadInstructionBundle(ctx.db)).tone).toBe("");
    expect((await req(ctx, s, { method: "DELETE", url: `/api/instructions/${v1.id}` })).statusCode).toBe(200);
  });
});

describe("suppressions", () => {
  it("lists, searches, imports and removes", async () => {
    const s = await loginAs(ctx, "operator");
    await req(ctx, s, { method: "POST", url: "/api/suppressions", payload: { email: "A@x.com", reason: "manual", note: "asked" } });
    const dupe = await req(ctx, s, { method: "POST", url: "/api/suppressions", payload: { email: "a@x.com", reason: "manual" } });
    expect(dupe.statusCode).toBe(200);
    const buffer = await xlsxBuffer(["Email"], [["b@x.com"], ["not valid"], ["a@x.com"]]);
    const mp = multipart({ file: { buffer, filename: "s.xlsx" } });
    expect(json(await req(ctx, s, { method: "POST", url: "/api/suppressions/import", payload: mp.payload, headers: mp.headers })).imported).toBe(1);
    const list = json(await req(ctx, s, { method: "GET", url: "/api/suppressions?search=x.com" }));
    expect(list.total).toBe(2);
    await req(ctx, s, { method: "DELETE", url: `/api/suppressions/${list.items[0].id}` });
    expect(json(await req(ctx, s, { method: "GET", url: "/api/suppressions" })).total).toBe(1);
  });
});

describe("unsubscribe links", () => {
  it("serves a confirmation page and one-click POST unsubscribes idempotently", async () => {
    const s = await loginAs(ctx, "operator");
    await createService(ctx, s);
    const c = await createCampaign(ctx, s, { rows: leadRows(1) });
    const [lead] = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    const page = await ctx.app.inject({ method: "GET", url: `/u/${lead.unsubscribeToken}` });
    expect(page.statusCode).toBe(200);
    // Landing page: services with link + contact buttons; the unsubscribe button is hidden by default.
    expect(page.body).toContain("Fleet Analytics");
    expect(page.body).not.toContain('class="unsub"');
    // Admins can switch the button on.
    const admin = await loginAs(ctx, "admin");
    await req(ctx, admin, { method: "PUT", url: "/api/settings/landing", payload: { showUnsubscribe: true } });
    const withButton = await ctx.app.inject({ method: "GET", url: `/u/${lead.unsubscribeToken}` });
    expect(withButton.body).toContain('class="unsub"');
    expect(withButton.body).toContain(">Unsubscribe</button>");
    // Clicking it asks for confirmation before anything is submitted.
    expect(withButton.body).toContain("Do you really want to leave us?");
    expect(withButton.body).toContain(">Yes, unsubscribe</button>");
    expect(withButton.body).toContain(">No, stay</button>");
    const post = await ctx.app.inject({ method: "POST", url: `/u/${lead.unsubscribeToken}`, payload: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(post.statusCode).toBe(200);
    const [after] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after.status).toBe("unsubscribed");
    expect((await ctx.db.select().from(suppressions))[0]).toMatchObject({ email: lead.email, reason: "unsubscribe" });
    const again = await ctx.app.inject({ method: "POST", url: `/u/${lead.unsubscribeToken}` });
    expect(again.statusCode).toBe(200);
    const unsubPage = (await ctx.app.inject({ method: "GET", url: `/u/${lead.unsubscribeToken}` })).body;
    expect(unsubPage).toContain("is unsubscribed");
    expect(unsubPage).toContain(">Subscribe again</button>");
    expect((await ctx.app.inject({ method: "GET", url: "/u/bogus.token" })).statusCode).toBe(404);
    expect(ctx.metrics.totals.unsubscribes).toBe(1);

    // Subscribe again: suppression lifted, lead no longer unsubscribed, page confirms.
    const back = await ctx.app.inject({ method: "POST", url: `/u/${lead.unsubscribeToken}/resubscribe`, headers: { accept: "text/html" } });
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain("is subscribed again");
    const [restored] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(restored.status).toBe("skipped"); // never emailed in this test
    expect(restored.unsubscribedAt).toBeNull();
    expect(await ctx.db.select().from(suppressions)).toHaveLength(0);
    expect(ctx.metrics.totals.resubscribes).toBe(1);
    expect((await ctx.app.inject({ method: "POST", url: `/u/bogus.token/resubscribe` })).statusCode).toBe(404);
  });

  it("lets admins shape the link page: service buttons, contact targets and the unsubscribe button", async () => {
    const admin = await loginAs(ctx, "admin");
    const operator = await loginAs(ctx, "operator");
    const svc = await createService(ctx, admin, "Route Optimiser");
    await req(ctx, admin, { method: "PATCH", url: `/api/services/${svc.id}`, payload: { url: "https://example.com/route-optimiser" } });
    const second = await createService(ctx, admin, "Fleet Analytics");
    const c = await createCampaign(ctx, admin, { rows: leadRows(1) });
    const [lead] = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));

    // Default: every active service, both buttons, unsubscribe shown.
    let page = (await ctx.app.inject({ method: "GET", url: `/u/${lead.unsubscribeToken}` })).body;
    expect(page).toContain("Route Optimiser");
    expect(page).toContain("Fleet Analytics");

    const config = {
      headline: "How we can help",
      intro: "Two things we do well.",
      emailLinkLabel: "Our services & preferences",
      showUnsubscribe: false,
      contactEmail: "hello@example.com",
      contactLabel: "Talk to us",
      linkLabel: "See details",
      services: [{ serviceId: svc.id, showLink: true, showContact: true, contactUrl: "https://cal.example.com/book" }],
    };
    expect((await req(ctx, operator, { method: "PUT", url: "/api/settings/landing", payload: config })).statusCode).toBe(403);
    let r = await req(ctx, admin, { method: "PUT", url: "/api/settings/landing", payload: config });
    expect(r.statusCode).toBe(200);
    expect(json(r).landingPage).toMatchObject({ showUnsubscribe: false, services: [{ serviceId: svc.id }] });

    page = (await ctx.app.inject({ method: "GET", url: `/u/${lead.unsubscribeToken}` })).body;
    expect(page).toContain("How we can help");
    expect(page).toContain("Route Optimiser");
    expect(page).not.toContain("Fleet Analytics");
    expect(page).toContain('href="https://cal.example.com/book"');
    expect(page).toContain(">Talk to us</a>");
    expect(page).toContain(">See details</a>");
    expect(page).not.toContain('class="unsub"');
    // One-click POST from mail clients still works even with the button hidden.
    const post = await ctx.app.inject({ method: "POST", url: `/u/${lead.unsubscribeToken}`, payload: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(post.statusCode).toBe(200);

    // The email footer uses the configured link text.
    const sent = await req(ctx, admin, { method: "GET", url: "/api/settings" });
    expect(json(sent).settings.landingPage.emailLinkLabel).toBe("Our services & preferences");

    // Preview renders a draft (any authenticated user) without touching the saved config.
    r = await req(ctx, operator, { method: "POST", url: "/api/settings/landing/preview", payload: { ...config, headline: "Draft headline", showUnsubscribe: true, services: [{ serviceId: second.id, showLink: false, showContact: false }] } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.body).toContain("Draft headline");
    expect(r.body).toContain("Fleet Analytics");
    expect(r.body).not.toContain("Route Optimiser");
    expect(r.body).not.toContain(">See details</a>");
    expect(r.body).toContain("Preview:");
    expect(json(await req(ctx, admin, { method: "GET", url: "/api/settings" })).settings.landingPage.headline).toBe("How we can help");
  });
});

describe("analytics + system", () => {
  it("aggregates overview, timeseries, llm usage and SES account info", async () => {
    const s = await loginAs(ctx, "operator");
    await createService(ctx, s);
    const c = await createCampaign(ctx, s, { rows: leadRows(2), payload: { approvalMode: "auto" } });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    const sent = await ctx.db.select().from(emails).where(eq(emails.campaignId, c.id));
    for (const e of sent) {
      await ctx.app.inject({ method: "POST", url: "/webhooks/ses/events", payload: snsNotification(sesEvent("Delivery", e.sesMessageId!, { delivery: { timestamp: new Date().toISOString() } })) });
    }
    await ctx.app.inject({ method: "POST", url: "/webhooks/ses/events", payload: snsNotification(sesEvent("Open", sent[0].sesMessageId!, { open: { timestamp: new Date().toISOString() } })) });
    const ov = json(await req(ctx, s, { method: "GET", url: "/api/analytics/overview" }));
    expect(ov.totals).toMatchObject({ leads: 2, sent: 2, delivered: 2, opened: 1 });
    expect(ov.rates.deliveryRate).toBe(100);
    expect(ov.rates.openRate).toBe(50);
    expect(ov.byCampaign[0]).toMatchObject({ campaignId: c.id, sent: 2, delivered: 2 });
    const ts = json(await req(ctx, s, { method: "GET", url: `/api/analytics/timeseries?campaignId=${c.id}` })).points;
    const today = ts.find((p: { date: string }) => p.date === new Date().toISOString().slice(0, 10));
    expect(today).toMatchObject({ sent: 2, delivered: 2, opened: 1 });
    const llm = json(await req(ctx, s, { method: "GET", url: "/api/analytics/llm-usage" }));
    expect(llm.calls).toBe(4);
    expect(llm.failures).toBe(0);
    const acct = json(await req(ctx, s, { method: "GET", url: "/api/analytics/ses-account" }));
    expect(acct.mode).toBe("mock");
    expect(acct.sendQuota.sentLast24Hours).toBe(2);
    const metrics = json(await req(ctx, s, { method: "GET", url: "/api/analytics/ses-metrics?hours=24" }));
    expect(metrics.enabled).toBe(false);
    await runSesSync(ctx);
    const status = json(await req(ctx, s, { method: "GET", url: "/api/system/status" }));
    expect(status.lastSesSyncAt).toBeTruthy();
    expect(status.sesMode).toBe("mock");
    expect((await ctx.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/nope" })).statusCode).toBe(404);
  });
});
