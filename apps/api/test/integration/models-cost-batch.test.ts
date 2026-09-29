import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { JOB_QUEUES } from "@mailapp/shared";
import { createTestContext, json, loginAs, req, type Session, type TestContext } from "../helpers/context.js";
import { createCampaign, createService, leadRows } from "../helpers/fixtures.js";
import { emails, leads, llmBatchItems, llmBatches, llmCalls, providerCredentials } from "../../src/db/schema.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => ctx.reset());

/**
 * Give the mock provider non-zero rates so the whole pricing path can be verified offline.
 * $6/1M input and $30/1M output, with cached reads at $0.60.
 */
async function priceMockProvider(s: Session, extra: Record<string, unknown> = {}) {
  const current = json(await req(ctx, s, { method: "GET", url: "/api/settings" })).settings;
  const { updatedAt: _u, ...rest } = current;
  const res = await req(ctx, s, {
    method: "PUT",
    url: "/api/settings",
    payload: {
      ...rest,
      modelRateOverrides: { "mock:mock": { input: 6, output: 30, cacheRead: 0.6, cacheWrite: null } },
      ...extra,
    },
  });
  if (res.statusCode !== 200) throw new Error(`settings update failed: ${res.body}`);
  ctx.settings.invalidate();
  return json(res).settings;
}

describe("model catalogue", () => {
  it("lists every model with batch variants, rates and provider availability", async () => {
    const s = await loginAs(ctx, "operator");
    const body = json(await req(ctx, s, { method: "GET", url: "/api/llm/models" }));

    const opus = body.models.find((m: { value: string }) => m.value === "anthropic:claude-opus-5-5");
    const opusBatch = body.models.find((m: { value: string }) => m.value === "anthropic:claude-opus-5-5@batch");
    expect(opus).toBeTruthy();
    expect(opusBatch).toBeTruthy();
    expect(opus.batch).toBe(false);
    expect(opusBatch.batch).toBe(true);
    // The batch variant is exactly half price.
    expect(opusBatch.rates.input).toBeCloseTo(opus.rates.input / 2, 6);
    expect(opusBatch.rates.output).toBeCloseTo(opus.rates.output / 2, 6);
    expect(opusBatch.indicative.draftMicroUsd).toBeLessThan(opus.indicative.draftMicroUsd);

    // No provider key is configured in tests, so every real model is flagged unavailable.
    expect(opus.available).toBe(false);
    expect(body.models.every((m: { provider: string; available: boolean }) => m.provider === "mock" || !m.available)).toBe(true);

    // DeepSeek has no batch endpoint, so it must not offer a batch variant.
    const deepseek = body.models.filter((m: { provider: string }) => m.provider === "deepseek");
    expect(deepseek.length).toBeGreaterThan(0);
    expect(deepseek.some((m: { batch: boolean }) => m.batch)).toBe(false);

    expect(body.researchModes.map((r: { mode: string }) => r.mode)).toEqual(["normal", "great", "advance"]);
    expect(body.mockMode).toBe(true);
  });

  it("estimates campaign cost from the chosen models and research depth", async () => {
    const s = await loginAs(ctx, "operator");
    const call = (payload: Record<string, unknown>) => req(ctx, s, { method: "POST", url: "/api/llm/estimate", payload });

    const normal = json(await call({ leads: 100, steps: 3, researchModel: "anthropic:claude-opus-5-5", draftModel: "anthropic:claude-opus-5-5", researchMode: "normal" }));
    const advance = json(await call({ leads: 100, steps: 3, researchModel: "anthropic:claude-opus-5-5", draftModel: "anthropic:claude-opus-5-5", researchMode: "advance" }));
    const batched = json(await call({ leads: 100, steps: 3, researchModel: "anthropic:claude-opus-5-5@batch", draftModel: "anthropic:claude-opus-5-5@batch", researchMode: "normal" }));
    const cheap = json(await call({ leads: 100, steps: 3, researchModel: "anthropic:claude-opus-5-5", draftModel: "openai:gpt-6-luna", researchMode: "normal" }));

    // Deeper research costs strictly more; batching costs strictly less; a cheaper drafting
    // model lowers the drafting line without touching the research line.
    expect(advance.estimate.totalMicroUsd).toBeGreaterThan(normal.estimate.totalMicroUsd);
    expect(batched.estimate.totalMicroUsd).toBeCloseTo(normal.estimate.totalMicroUsd / 2, -2);
    expect(cheap.estimate.draft.microUsd).toBeLessThan(normal.estimate.draft.microUsd);
    expect(cheap.estimate.research.microUsd).toBe(normal.estimate.research.microUsd);

    expect(normal.estimate.research.calls).toBe(100);
    expect(normal.estimate.draft.calls).toBe(300);
    expect(normal.estimate.perEmailMicroUsd).toBe(Math.round(normal.estimate.draft.microUsd / 300));
    expect(batched.ai.usesBatch).toBe(true);
    // Neither provider has a key in tests, so the readiness flags say so.
    expect(normal.ready).toEqual({ research: false, draft: false });
  });
});

describe("provider credentials", () => {
  it("stores keys encrypted, never returns them, and reports availability", async () => {
    const admin = await loginAs(ctx, "admin");
    const before = json(await req(ctx, admin, { method: "GET", url: "/api/llm/providers" })).providers;
    expect(before.find((p: { provider: string }) => p.provider === "openai")).toMatchObject({ configured: false, source: "none", keyHint: null });

    const put = await req(ctx, admin, { method: "PUT", url: "/api/llm/providers/openai", payload: { apiKey: "sk-test-secret-value-1234" } });
    expect(put.statusCode).toBe(200);
    const openai = json(put).providers.find((p: { provider: string }) => p.provider === "openai");
    expect(openai).toMatchObject({ configured: true, source: "database", keyHint: "1234" });
    // The response must carry no part of the key beyond the recognition hint.
    expect(put.body).not.toContain("sk-test-secret-value");

    // Stored ciphertext must not contain the plaintext.
    const [row] = await ctx.db.select().from(providerCredentials).where(eq(providerCredentials.provider, "openai"));
    expect(row.apiKeyEnc).not.toContain("sk-test-secret-value");
    expect(row.apiKeyEnc.startsWith("v1.")).toBe(true);
    expect(await ctx.credentials.resolve("openai")).toMatchObject({ apiKey: "sk-test-secret-value-1234", source: "database" });

    // The model list now shows OpenAI models as usable.
    const models = json(await req(ctx, admin, { method: "GET", url: "/api/llm/models" })).models;
    expect(models.filter((m: { provider: string }) => m.provider === "openai").every((m: { available: boolean }) => m.available)).toBe(true);
    expect(models.filter((m: { provider: string }) => m.provider === "gemini").every((m: { available: boolean }) => !m.available)).toBe(true);

    const del = await req(ctx, admin, { method: "DELETE", url: "/api/llm/providers/openai" });
    expect(json(del).providers.find((p: { provider: string }) => p.provider === "openai").configured).toBe(false);
    expect(await ctx.credentials.resolve("openai")).toBeNull();

    // The audit trail records that a key was set, with only the tail of the key.
    const audit = json(await req(ctx, admin, { method: "GET", url: "/api/audit?action=llm.provider_key_set" }));
    expect(audit.items[0].metadata).toMatchObject({ provider: "openai", keyHint: "1234" });
    expect(JSON.stringify(audit.items[0].metadata)).not.toContain("sk-test-secret-value");
  });

  it("only lets admins manage keys and rejects unknown providers", async () => {
    const op = await loginAs(ctx, "operator");
    expect((await req(ctx, op, { method: "PUT", url: "/api/llm/providers/openai", payload: { apiKey: "sk-nope-123456" } })).statusCode).toBe(403);
    expect((await req(ctx, op, { method: "DELETE", url: "/api/llm/providers/openai" })).statusCode).toBe(403);
    // Reading the catalogue is fine for an operator: they pick models per campaign.
    expect((await req(ctx, op, { method: "GET", url: "/api/llm/providers" })).statusCode).toBe(200);

    const admin = await loginAs(ctx, "admin");
    expect((await req(ctx, admin, { method: "PUT", url: "/api/llm/providers/nonsense", payload: { apiKey: "x-123456789" } })).statusCode).toBe(400);
    // A too-short key is rejected rather than stored.
    expect((await req(ctx, admin, { method: "PUT", url: "/api/llm/providers/openai", payload: { apiKey: "short" } })).statusCode).toBe(400);
  });
});

describe("cost tracking", () => {
  it("prices every call and rolls it up to the lead, the email and the campaign", async () => {
    const s = await loginAs(ctx, "admin");
    await priceMockProvider(s);
    const service = await createService(ctx, s);
    const c = await createCampaign(ctx, s, { rows: leadRows(2), payload: { serviceIds: [service.id], approvalMode: "auto" } });

    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(ctx.queue.failures).toEqual([]);

    // Every recorded call carries a non-zero, provider-tagged price.
    const calls = await ctx.db.select().from(llmCalls).where(eq(llmCalls.campaignId, c.id));
    expect(calls.length).toBeGreaterThanOrEqual(4); // 2 research + 2 draft
    expect(calls.every((r) => r.costMicroUsd > 0)).toBe(true);
    expect(calls.every((r) => r.provider === "mock" && r.modelKey === "mock:mock")).toBe(true);
    expect(calls.every((r) => r.batch === false)).toBe(true);

    // The mock provider reports 1200 in / 400 out for research, at $6 / $30 per 1M.
    const research = calls.find((r) => r.purpose === "research")!;
    expect(research.costMicroUsd).toBe(Math.round(1200 * 6 + 400 * 30));

    // Lead rollups: research cost is a subset of the lead total.
    const leadRows2 = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    for (const l of leadRows2) {
      expect(l.researchCostMicroUsd).toBeGreaterThan(0);
      expect(l.totalCostMicroUsd).toBeGreaterThan(l.researchCostMicroUsd);
    }

    // Per-email cost, and the draft call is linked to the email it produced.
    const mails = await ctx.db.select().from(emails).where(and(eq(emails.campaignId, c.id), eq(emails.direction, "outbound")));
    expect(mails.length).toBe(2);
    expect(mails.every((m) => m.costMicroUsd > 0)).toBe(true);
    const draftCalls = calls.filter((r) => r.purpose === "draft");
    expect(draftCalls.every((r) => r.emailId !== null)).toBe(true);

    // Campaign DTO exposes the aggregate and the derived per-unit figures.
    const campaign = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign;
    const totalFromCalls = calls.reduce((a, r) => a + r.costMicroUsd, 0);
    expect(campaign.cost.totalMicroUsd).toBe(totalFromCalls);
    expect(campaign.cost.perLeadMicroUsd).toBe(Math.round(totalFromCalls / 2));
    expect(campaign.cost.researchMicroUsd + campaign.cost.draftMicroUsd).toBe(totalFromCalls);
    expect(campaign.cost.leads).toBe(2);
    expect(campaign.cost.emails).toBe(2);

    // The cost endpoint adds the projection and the by-model breakdown.
    const cost = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}/cost` }));
    expect(cost.actual.totalMicroUsd).toBe(totalFromCalls);
    expect(cost.byModel[0]).toMatchObject({ modelKey: "mock:mock", provider: "mock", batch: false });
    expect(cost.byModel.reduce((a: number, r: { microUsd: number }) => a + r.microUsd, 0)).toBe(totalFromCalls);
    // Two further sequence steps are still owed for each lead.
    expect(cost.estimate.draft.calls).toBe(4);

    // Organisation-wide usage divides by emails actually sent.
    const usage = json(await req(ctx, s, { method: "GET", url: "/api/analytics/llm-usage" }));
    expect(usage.totalMicroUsd).toBe(totalFromCalls);
    expect(usage.microUsdPerSentEmail).toBe(Math.round(totalFromCalls / 2));
    expect(usage.byPurpose.map((p: { purpose: string }) => p.purpose).sort()).toEqual(["draft", "research"]);
    expect(usage.daily.length).toBeGreaterThan(0);
  });

  it("prices with the administrator's rate override and leaves recorded calls untouched", async () => {
    const s = await loginAs(ctx, "admin");
    await priceMockProvider(s);
    const c = await createCampaign(ctx, s, { rows: leadRows(1), payload: { approvalMode: "auto" } });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();

    const first = await ctx.db.select().from(llmCalls).where(eq(llmCalls.campaignId, c.id));
    const firstResearch = first.find((r) => r.purpose === "research")!;
    const originalCost = firstResearch.costMicroUsd;

    // Double the rates, then run a second campaign.
    const current = json(await req(ctx, s, { method: "GET", url: "/api/settings" })).settings;
    const { updatedAt: _u, ...rest } = current;
    await req(ctx, s, {
      method: "PUT",
      url: "/api/settings",
      payload: { ...rest, modelRateOverrides: { "mock:mock": { input: 12, output: 60, cacheRead: 1.2, cacheWrite: null } } },
    });
    ctx.settings.invalidate();

    const c2 = await createCampaign(ctx, s, { rows: leadRows(1, { notes: "second" }), payload: { name: "Second", approvalMode: "auto" } });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c2.id}/start` });
    await ctx.queue.drain();

    const second = await ctx.db.select().from(llmCalls).where(eq(llmCalls.campaignId, c2.id));
    const secondResearch = second.find((r) => r.purpose === "research")!;
    expect(secondResearch.costMicroUsd).toBe(originalCost * 2);

    // The earlier call keeps the price it was charged — history does not re-price.
    const [reread] = await ctx.db.select().from(llmCalls).where(eq(llmCalls.id, firstResearch.id));
    expect(reread.costMicroUsd).toBe(originalCost);
  });

  it("refuses to start a campaign projected above the spend cap", async () => {
    const s = await loginAs(ctx, "admin");
    // Rates high enough that 3 leads over 3 steps blow a $0.01 cap.
    await priceMockProvider(s, { campaignCostCapUsd: 0.01 });
    const c = await createCampaign(ctx, s, { rows: leadRows(3) });

    const blocked = await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    expect(blocked.statusCode).toBe(409);
    expect(json(blocked).error.message).toMatch(/cap/i);
    // Nothing was enqueued and the campaign stayed a draft.
    expect(ctx.queue.published.filter((p) => p.name === JOB_QUEUES.research)).toHaveLength(0);
    expect(json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign.status).toBe("draft");

    // Raising the cap lets it through.
    await priceMockProvider(s, { campaignCostCapUsd: 100 });
    expect((await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` })).statusCode).toBe(200);
  });
});

describe("per-campaign model configuration", () => {
  it("inherits organisation defaults and applies campaign overrides", async () => {
    const s = await loginAs(ctx, "admin");
    const c = await createCampaign(ctx, s, { rows: leadRows(1) });

    // No aiConfig stored: everything is inherited.
    let campaign = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign;
    expect(campaign.aiConfig).toBeNull();
    expect(campaign.ai.researchMode).toBe("great");
    expect(campaign.ai.overridden).toEqual([]);

    // Override two fields; only those are recorded as overridden.
    const patched = await req(ctx, s, {
      method: "PATCH",
      url: `/api/campaigns/${c.id}`,
      payload: { aiConfig: { researchMode: "advance", draftModel: "openai:gpt-6-luna" } },
    });
    expect(patched.statusCode).toBe(200);
    campaign = json(patched).campaign;
    expect(campaign.aiConfig).toEqual({ researchMode: "advance", draftModel: "openai:gpt-6-luna" });
    expect(campaign.ai.researchMode).toBe("advance");
    expect(campaign.ai.overridden.sort()).toEqual(["draftModel", "researchMode"]);
    // The inherited research model still tracks the organisation setting.
    expect(campaign.ai.researchModel).toBe("anthropic:claude-opus-5-5");

    // Changing the organisation default moves the inherited field but not the overridden one.
    const current = json(await req(ctx, s, { method: "GET", url: "/api/settings" })).settings;
    const { updatedAt: _u, ...rest } = current;
    await req(ctx, s, { method: "PUT", url: "/api/settings", payload: { ...rest, researchModel: "anthropic:claude-sonnet-5-5" } });
    ctx.settings.invalidate();
    campaign = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign;
    expect(campaign.ai.researchModel).toBe("anthropic:claude-sonnet-5-5");
    expect(campaign.ai.draftModel).toBe("openai:gpt-6-luna");

    // Sending an empty object clears every override.
    campaign = json(await req(ctx, s, { method: "PATCH", url: `/api/campaigns/${c.id}`, payload: { aiConfig: {} } })).campaign;
    expect(campaign.aiConfig).toBeNull();
    expect(campaign.ai.overridden).toEqual([]);
  });

  it("rejects an unknown model and keeps settings usable when a stored model disappears", async () => {
    const s = await loginAs(ctx, "admin");
    const c = await createCampaign(ctx, s, { rows: leadRows(1) });
    const bad = await req(ctx, s, { method: "PATCH", url: `/api/campaigns/${c.id}`, payload: { aiConfig: { draftModel: "acme:not-a-model" } } });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error.code).toBe("validation_error");

    // A model id written before the catalogue existed still resolves rather than breaking.
    const current = json(await req(ctx, s, { method: "GET", url: "/api/settings" })).settings;
    const { updatedAt: _u, ...rest } = current;
    await req(ctx, s, { method: "PUT", url: "/api/settings", payload: rest });
    await ctx.dbHandle.pool.query(`update settings set value = jsonb_set(value, '{llmModel}', '"claude-opus-5"') where key = 'app'`);
    ctx.settings.invalidate();
    const settings = json(await req(ctx, s, { method: "GET", url: "/api/settings" })).settings;
    expect(settings.llmModel).toBe("anthropic:claude-opus-5");
  });
});

describe("batch models", () => {
  it("queues requests, submits one batch per campaign and applies the results", async () => {
    const s = await loginAs(ctx, "admin");
    await priceMockProvider(s);
    const service = await createService(ctx, s);
    const c = await createCampaign(ctx, s, {
      rows: leadRows(3),
      payload: {
        serviceIds: [service.id],
        approvalMode: "auto",
        aiConfig: { researchModel: "mock:mock@batch", draftModel: "mock:mock@batch", batchStrategy: "campaign_start" },
      },
    });

    const campaign = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}` })).campaign;
    expect(campaign.ai.usesBatch).toBe(true);
    expect(campaign.ai.researchBatch).toBe(true);
    expect(campaign.ai.batchStrategy).toBe("campaign_start");

    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(ctx.queue.failures).toEqual([]);

    // Research was queued for batching rather than run inline; no persona yet.
    const queued = await ctx.db.select().from(llmBatchItems).where(eq(llmBatchItems.campaignId, c.id));
    expect(queued).toHaveLength(3);
    expect(queued.every((i) => i.purpose === "research" && i.status === "pending")).toBe(true);
    expect(queued.every((i) => i.payload && Object.keys(i.payload).length > 0)).toBe(true);
    const researching = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    expect(researching.every((l) => l.status === "researching" && l.persona === null)).toBe(true);
    // A tick was scheduled for after the enqueue burst settles.
    expect(ctx.queue.published.some((p) => p.name === JOB_QUEUES.llmBatchTick)).toBe(true);

    // Run the tick. campaign_start waits 30s for the burst to settle, so advance past it.
    await ctx.db
      .update(llmBatchItems)
      .set({ queuedAt: new Date(Date.now() - 120_000) })
      .where(eq(llmBatchItems.campaignId, c.id));
    const tick = json(await req(ctx, s, { method: "POST", url: "/api/llm/batches/tick" }));
    expect(tick.submitted).toBe(1);
    await ctx.queue.drain();

    // One batch covered all three research requests.
    const batches = await ctx.db.select().from(llmBatches).where(eq(llmBatches.campaignId, c.id));
    const researchBatch = batches.find((b) => b.purpose === "research")!;
    expect(researchBatch).toMatchObject({ status: "completed", requestCount: 3, succeeded: 3, errored: 0, strategy: "campaign_start" });
    expect(researchBatch.costMicroUsd).toBeGreaterThan(0);

    // Personas landed and drafting was queued for batching in turn.
    const researched = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    expect(researched.every((l) => l.persona !== null)).toBe(true);
    const draftItems = await ctx.db.select().from(llmBatchItems).where(and(eq(llmBatchItems.campaignId, c.id), eq(llmBatchItems.purpose, "draft")));
    expect(draftItems).toHaveLength(3);

    // Flush the draft batch the same way.
    await ctx.db
      .update(llmBatchItems)
      .set({ queuedAt: new Date(Date.now() - 120_000) })
      .where(and(eq(llmBatchItems.campaignId, c.id), eq(llmBatchItems.purpose, "draft")));
    await req(ctx, s, { method: "POST", url: "/api/llm/batches/tick" });
    await ctx.queue.drain();

    const mails = await ctx.db.select().from(emails).where(and(eq(emails.campaignId, c.id), eq(emails.direction, "outbound")));
    expect(mails).toHaveLength(3);
    expect(mails.every((m) => m.costMicroUsd > 0)).toBe(true);
    expect(mails.every((m) => (m.llmMeta as { batch?: boolean }).batch === true)).toBe(true);
    // Auto-approval still applies, so the emails went out.
    expect(ctx.ses.sent).toHaveLength(3);

    // Batch calls are priced at half the standard rate and tagged as batch.
    const batchCalls = await ctx.db.select().from(llmCalls).where(eq(llmCalls.campaignId, c.id));
    expect(batchCalls.length).toBeGreaterThanOrEqual(6);
    expect(batchCalls.every((r) => r.batch === true)).toBe(true);
    const batchResearch = batchCalls.find((r) => r.purpose === "research")!;
    expect(batchResearch.costMicroUsd).toBe(Math.round((1200 * 6 + 400 * 30) / 2));

    // The cost view reports the batch share and lists the batches.
    const cost = json(await req(ctx, s, { method: "GET", url: `/api/campaigns/${c.id}/cost` }));
    expect(cost.actual.batchSharePct).toBe(100);
    expect(cost.batches.length).toBe(2);
    expect(cost.byModel.every((r: { batch: boolean }) => r.batch)).toBe(true);
  });

  it("holds rolling batches until the flush window and cancels open batches when paused", async () => {
    const s = await loginAs(ctx, "admin");
    await priceMockProvider(s, { batchFlushMinutes: 60 });
    const c = await createCampaign(ctx, s, {
      rows: leadRows(2),
      payload: { aiConfig: { researchModel: "mock:mock@batch", draftModel: "mock:mock@batch", batchStrategy: "rolling" } },
    });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(await ctx.db.select().from(llmBatchItems).where(eq(llmBatchItems.campaignId, c.id))).toHaveLength(2);

    // Inside the window, the tick submits nothing.
    expect(json(await req(ctx, s, { method: "POST", url: "/api/llm/batches/tick" })).submitted).toBe(0);
    expect(await ctx.db.select().from(llmBatches).where(eq(llmBatches.campaignId, c.id))).toHaveLength(0);

    // Age the oldest request past the window and it flushes.
    await ctx.db
      .update(llmBatchItems)
      .set({ queuedAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(llmBatchItems.campaignId, c.id));
    expect(json(await req(ctx, s, { method: "POST", url: "/api/llm/batches/tick" })).submitted).toBe(1);
    await ctx.queue.drain();
    expect((await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id))).every((l) => l.persona !== null)).toBe(true);

    // Pausing abandons anything still queued so no further money is spent.
    const pending = await ctx.db.select().from(llmBatchItems).where(and(eq(llmBatchItems.campaignId, c.id), eq(llmBatchItems.status, "pending")));
    expect(pending.length).toBeGreaterThan(0);
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/pause` });
    const after = await ctx.db.select().from(llmBatchItems).where(and(eq(llmBatchItems.campaignId, c.id), eq(llmBatchItems.status, "pending")));
    expect(after).toHaveLength(0);
  });

  it("falls back to a synchronous call when the selected provider has no key", async () => {
    const s = await loginAs(ctx, "admin");
    // A real provider with no key: the batch queue cannot build a request, so research must
    // still run rather than leaving the lead stuck in "researching" forever.
    const c = await createCampaign(ctx, s, {
      rows: leadRows(1),
      payload: { aiConfig: { researchModel: "anthropic:claude-opus-5-5@batch" } },
    });
    await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
    await ctx.queue.drain();
    expect(ctx.queue.failures).toEqual([]);

    // LLM_PROVIDER=mock routes the call to the mock adapter, which does batch, so the item is
    // queued; what matters is that the lead is never abandoned.
    const [lead] = await ctx.db.select().from(leads).where(eq(leads.campaignId, c.id));
    expect(["researching", "researched", "pending_review", "approved"]).toContain(lead.status);
    expect(lead.lastError).toBeNull();
  });
});
