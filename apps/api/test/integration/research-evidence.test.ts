import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestContext, json, loginAs, req, type TestContext } from "../helpers/context.js";
import { createCampaign } from "../helpers/fixtures.js";
import { leads } from "../../src/db/schema.js";

// Website fetching is on for this suite; global fetch is stubbed so nothing leaves the machine.
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({ WEBSITE_FETCH_ENABLED: "true" });
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await ctx.reset();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("acme.example.com")) {
      return new Response(
        `<html><head><title>Acme</title><meta name="description" content="Acme builds warehouse robots"></head>
         <body><h1>Warehouse robots</h1><h2>Fleet software</h2></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response("unavailable", { status: 503, headers: { "content-type": "text/html" } });
  });
});
afterEach(() => vi.restoreAllMocks());

// Columns: First Name, Last Name, Email, Company, Website, Job Title, Industry, Notes, Account Owner
const row = (email: string, website: string, notes = "") => ["Ann", "Lee", email, "Acme", website, "COO", "Logistics", notes, ""];

async function runCampaign(rows: unknown[][]) {
  const s = await loginAs(ctx, "operator");
  const c = await createCampaign(ctx, s, { rows: rows as never });
  await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
  await ctx.queue.drain();
  const stored = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
  return { s, stored };
}

describe("evidence-based research", () => {
  it("stores complete, sourced research against the right lead and continues to drafting", async () => {
    const { s, stored } = await runCampaign([row("ann@acme.example.com", "https://acme.example.com"), row("bob@down.example.org", "https://down.example.org")]);
    const lead = stored.find((l) => l.email === "ann@acme.example.com")!;
    expect(lead.researchStatus).toBe("complete");
    expect(lead.researchIssues).toEqual([]);
    expect(lead.persona!.sources).toEqual(["https://acme.example.com/"]);
    const verified = lead.persona!.evidence.filter((e) => e.basis === "verified");
    expect(verified.length).toBeGreaterThanOrEqual(2);
    for (const e of verified) expect(e.sourceUrl).toBe("https://acme.example.com/");
    expect(lead.persona!.opportunities.length).toBeGreaterThan(0);
    expect(lead.researchRaw).toMatchObject({ quality: { verifiedCount: verified.length } });
    // Downstream: drafting consumed the persona.
    expect(lead.status).toBe("pending_review");

    // And the API exposes it to the dashboard.
    const detail = json(await req(ctx, s, { method: "GET", url: `/api/leads/${lead.id}` })).lead;
    expect(detail.researchStatus).toBe("complete");
    expect(detail.persona.evidence[0].sourceUrl).toBe("https://acme.example.com/");
  });

  it("marks research partial when the website is unavailable, without inventing verified facts", async () => {
    const partialBefore = ctx.metrics.totals.research_partial ?? 0;
    const { stored } = await runCampaign([row("bob@down.example.org", "https://down.example.org")]);
    const [lead] = stored;
    expect(lead.researchStatus).toBe("partial");
    expect(lead.researchIssues).toEqual(expect.arrayContaining(["website_unavailable", "no_sources", "few_verified_facts", "low_confidence"]));
    expect(lead.persona!.evidence.every((e) => e.basis === "inferred")).toBe(true);
    expect(lead.persona!.confidence).toBe("low");
    expect(ctx.metrics.totals.research_partial).toBe(partialBefore + 1);
    // Partial research still produces a draft for a human to review.
    expect(lead.status).toBe("pending_review");
  });

  it("downgrades a claim the model marked verified without a source", async () => {
    const { stored } = await runCampaign([row("ann@acme.example.com", "https://acme.example.com", "mock:unsourced-claim")]);
    const [lead] = stored;
    const funding = lead.persona!.evidence.find((e) => e.claim.includes("raised funding"))!;
    expect(funding.basis).toBe("inferred");
    expect(lead.researchIssues).toContain("unsourced_claims_downgraded");
    expect(lead.researchStatus).toBe("complete");
  });

  it("records a failed research run and recovers on retry", async () => {
    const { s, stored } = await runCampaign([row("ann@acme.example.com", "https://acme.example.com", "mock:fail-research")]);
    const [lead] = stored;
    expect(lead.status).toBe("failed");
    expect(lead.researchStatus).toBe("failed");
    expect(lead.persona).toBeNull();
    expect(lead.lastError).toContain("research");

    await ctx.db.update(leads).set({ notes: "" }).where(eq(leads.id, lead.id));
    await req(ctx, s, { method: "POST", url: `/api/leads/${lead.id}/retry` });
    await ctx.queue.drain();
    const [after] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after.researchStatus).toBe("complete");
    expect(after.status).toBe("pending_review");
  });
});
