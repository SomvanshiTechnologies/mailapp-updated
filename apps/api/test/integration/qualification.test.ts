import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { JOB_QUEUES } from "@mailapp/shared";
import { createTestContext, json, loginAs, req, type TestContext } from "../helpers/context.js";
import { createCampaign, createService } from "../helpers/fixtures.js";
import { emails, leads, llmCalls } from "../../src/db/schema.js";

// Qualification and website fetching are on; global fetch is stubbed (nothing leaves the machine).
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({ WEBSITE_FETCH_ENABLED: "true", QUALIFICATION_ENABLED: "true" });
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await ctx.reset();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("acme.example.com")) {
      return new Response(
        `<html><head><title>Acme</title><meta name="description" content="Acme runs a 300-van delivery fleet"></head>
         <body><h1>Same-day delivery</h1><h2>Fleet of 300 vans</h2></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response("unavailable", { status: 503, headers: { "content-type": "text/html" } });
  });
});
afterEach(() => vi.restoreAllMocks());

// Columns: First Name, Last Name, Email, Company, Website, Job Title, Industry, Notes, Account Owner
const ACME = "https://acme.example.com";
const row = (email: string, notes = "", website = ACME) => ["Ann", "Lee", email, "Acme", website, "COO", "Logistics", notes, ""];

async function run(rows: unknown[][], opts: { withService?: boolean } = {}) {
  const s = await loginAs(ctx, "operator");
  const service = opts.withService === false ? null : await createService(ctx, s);
  const c = await createCampaign(ctx, s, { rows: rows as never, payload: service ? { serviceIds: [service.id] } : {} });
  await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
  await ctx.queue.drain();
  const stored = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
  const byEmail = (e: string) => stored.find((l) => l.email === e)!;
  const draftsFor = async (leadId: string) => ctx.db.select().from(emails).where(eq(emails.leadId, leadId));
  return { s, c, service, byEmail, draftsFor };
}

describe("qualification and service matching", () => {
  it("qualifies a well-evidenced lead, matches a catalogue service and drafts with it", async () => {
    const { s, c, service, byEmail, draftsFor } = await run([row("ann@acme.example.com")]);
    const lead = byEmail("ann@acme.example.com");
    expect(lead.qualificationStatus).toBe("qualified");
    expect(lead.qualification!.decidedBy).toBe("ai");
    expect(lead.qualification!.service).toMatchObject({ serviceId: service!.id, serviceName: "Fleet Analytics" });
    // The recommendation cites verified evidence from the research.
    const support = lead.qualification!.service!.supportingEvidence;
    expect(support.length).toBeGreaterThan(0);
    expect(support.every((e) => e.basis === "verified" && e.sourceUrl.startsWith(ACME))).toBe(true);
    // Drafting ran and kept the qualification's service as the match.
    expect(lead.status).toBe("pending_review");
    expect(await draftsFor(lead.id)).toHaveLength(1);
    expect(lead.matchedServices).toEqual([expect.objectContaining({ serviceId: service!.id })]);

    const detail = json(await req(ctx, s, { method: "GET", url: `/api/leads/${lead.id}` })).lead;
    expect(detail.qualificationStatus).toBe("qualified");
    expect(detail.qualification.service.serviceId).toBe(service!.id);
    const camp = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign;
    expect(camp.counts.pendingReview).toBe(1);
  });

  it("stops unqualified leads before drafting", async () => {
    const { s, c, byEmail, draftsFor } = await run([row("bob@acme.example.com", "mock:unqualified")]);
    const lead = byEmail("bob@acme.example.com");
    expect(lead.status).toBe("unqualified");
    expect(lead.qualificationStatus).toBe("unqualified");
    expect(lead.qualification!.service).toBeNull();
    expect(await draftsFor(lead.id)).toHaveLength(0);
    expect(ctx.queue.published.some((p) => p.name === JOB_QUEUES.draft && (p.data as { leadId: string }).leadId === lead.id)).toBe(false);
    const camp = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign;
    expect(camp.counts.unqualified).toBe(1);

    // Even a stray draft job for this lead produces nothing.
    await ctx.queue.publish(JOB_QUEUES.draft, { leadId: lead.id, step: 1 });
    await ctx.queue.drain();
    expect(await draftsFor(lead.id)).toHaveLength(0);
  });

  it("puts leads without verified evidence on hold as needs_research, without calling the model", async () => {
    const { s, c, byEmail, draftsFor } = await run([row("cy@down.example.org", "", "https://down.example.org")]);
    const lead = byEmail("cy@down.example.org");
    expect(lead.researchStatus).toBe("partial");
    expect(lead.status).toBe("on_hold");
    expect(lead.qualificationStatus).toBe("needs_research");
    expect(lead.qualification!.decidedBy).toBe("rules");
    expect(await draftsFor(lead.id)).toHaveLength(0);
    const calls = await ctx.db.select().from(llmCalls).where(and(eq(llmCalls.leadId, lead.id), eq(llmCalls.purpose, "qualify")));
    expect(calls).toHaveLength(0);
    const camp = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign;
    expect(camp.counts.onHold).toBe(1);
    expect(camp.status).toBe("active"); // waits for a person; the campaign does not complete
  });

  it("holds human_review leads", async () => {
    const { byEmail, draftsFor } = await run([row("dee@acme.example.com", "mock:human-review")]);
    const lead = byEmail("dee@acme.example.com");
    expect(lead.status).toBe("on_hold");
    expect(lead.qualificationStatus).toBe("human_review");
    expect(await draftsFor(lead.id)).toHaveLength(0);
  });

  it("returns no suitable service and routes the lead to human review", async () => {
    const { byEmail, draftsFor } = await run([row("eve@acme.example.com", "mock:no-service")]);
    const lead = byEmail("eve@acme.example.com");
    expect(lead.qualificationStatus).toBe("human_review");
    expect(lead.qualification!.modelOutcome).toBe("qualified");
    expect(lead.qualification!.service).toBeNull();
    expect(lead.qualification!.noServiceReason).toBeTruthy();
    expect(lead.matchedServices).toEqual([]);
    expect(await draftsFor(lead.id)).toHaveLength(0);
  });

  it("handles a campaign with an empty service catalogue", async () => {
    const { byEmail } = await run([row("fay@acme.example.com")], { withService: false });
    const lead = byEmail("fay@acme.example.com");
    expect(lead.qualificationStatus).toBe("human_review");
    expect(lead.qualification!.service).toBeNull();
  });

  it("rejects a recommended service that is not in the catalogue", async () => {
    const { byEmail } = await run([row("gus@acme.example.com", "mock:bad-service")]);
    const lead = byEmail("gus@acme.example.com");
    expect(lead.qualification!.service).toBeNull();
    expect(lead.qualificationStatus).toBe("human_review");
    expect(lead.qualification!.adjustments.join(" ")).toMatch(/not in this campaign's service catalogue/);
  });

  it("does not auto-qualify when the service is backed only by inferred evidence", async () => {
    const { byEmail } = await run([row("hal@acme.example.com", "mock:unsupported-service")]);
    const lead = byEmail("hal@acme.example.com");
    expect(lead.qualificationStatus).toBe("human_review");
    expect(lead.qualification!.adjustments.join(" ")).toMatch(/not supported by any verified evidence/);
  });

  it("records a failed qualification and re-qualifies on retry", async () => {
    const { s, byEmail, draftsFor } = await run([row("ivy@acme.example.com", "mock:fail-qualify")]);
    const lead = byEmail("ivy@acme.example.com");
    expect(lead.status).toBe("failed");
    expect(lead.lastError).toMatch(/^qualify:/);
    expect(lead.researchStatus).toBe("complete"); // research itself succeeded

    await ctx.db.update(leads).set({ notes: "" }).where(eq(leads.id, lead.id));
    await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/retry` });
    await ctx.queue.drain();
    const [after] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after.qualificationStatus).toBe("qualified");
    expect(after.status).toBe("pending_review");
    expect(await draftsFor(lead.id)).toHaveLength(1);
  });

  it("lets an operator qualify an on-hold lead with a chosen service, which then drafts", async () => {
    const { s, service, byEmail, draftsFor } = await run([row("jo@acme.example.com", "mock:human-review")]);
    const lead = byEmail("jo@acme.example.com");
    const res = await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/qualification`, payload: { decision: "qualify", serviceId: service!.id, note: "Known account" } });
    expect(res.statusCode).toBe(200);
    await ctx.queue.drain();
    const [after] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after.qualificationStatus).toBe("qualified");
    expect(after.qualification!.decidedBy).toBe("human");
    expect(after.qualification!.adjustments.at(-1)).toMatch(/Known account/);
    expect(after.status).toBe("pending_review");
    expect(await draftsFor(lead.id)).toHaveLength(1);

    // Once drafted, the decision is locked.
    const late = await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/qualification`, payload: { decision: "disqualify" } });
    expect(late.statusCode).toBe(409);
  });

  it("lets an operator disqualify a lead, and rejects services outside the campaign", async () => {
    const { s, byEmail } = await run([row("kim@acme.example.com", "mock:human-review")]);
    const lead = byEmail("kim@acme.example.com");
    const other = await createService(ctx, s, "Unrelated Service");
    const bad = await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/qualification`, payload: { decision: "qualify", serviceId: other.id } });
    expect(bad.statusCode).toBe(400);

    const res = await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/qualification`, payload: { decision: "disqualify" } });
    expect(json(res).lead.status).toBe("unqualified");
    expect(json(res).lead.qualification.decidedBy).toBe("human");
  });

  it("allows re-researching an unqualified lead", async () => {
    const { s, byEmail } = await run([row("lou@acme.example.com", "mock:unqualified")]);
    const lead = byEmail("lou@acme.example.com");
    await ctx.db.update(leads).set({ notes: "" }).where(eq(leads.id, lead.id));
    const res = await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/research` });
    expect(res.statusCode).toBe(200);
    await ctx.queue.drain();
    const [after] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after.qualificationStatus).toBe("qualified");
    expect(after.status).toBe("pending_review");
  });
});
