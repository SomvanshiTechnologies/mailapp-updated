import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  BATCH_STATUSES,
  CONFIGURABLE_PROVIDERS,
  PROVIDER_LABELS,
  ProviderCredentialSchema,
  ProviderParamSchema,
  RESEARCH_MODE_PROFILES,
  RATES_CAPTURED_AT,
  estimateCost,
  type BatchDto,
  type BatchStatus,
  type ConfigurableProvider,
  type ModelOptionDto,
  type ProviderStatusDto,
  type ResearchMode,
} from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, llmBatchItems, llmBatches } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { parse } from "../../lib/validate.js";
import { modelOptionDtos, resolveModel } from "./catalogue.js";
import { LlmRouter } from "./router.js";
import { cancelCampaignBatches, runBatchTick } from "./batch/runner.js";

/**
 * Model catalogue, provider credentials and batch visibility.
 *
 * Reading the catalogue needs only a login (operators pick models per campaign); changing a
 * key or a rate is administrator-only, and no endpoint ever returns a stored key.
 */
export async function llmRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /** The picker's data: every model, its rates, and whether its provider has a key. */
  app.get("/api/llm/models", { preHandler: app.authenticate }, async () => {
    const settings = await ctx.settings.get();
    const available = await ctx.credentials.availableProviders();
    const includeMock = ctx.config.LLM_PROVIDER === "mock";
    const models: ModelOptionDto[] = modelOptionDtos(settings, available, includeMock);
    return {
      models,
      providers: await ctx.credentials.status(),
      researchModes: Object.entries(RESEARCH_MODE_PROFILES).map(([mode, p]) => ({
        mode: mode as ResearchMode,
        label: p.label,
        description: p.description,
        effort: p.effort,
        maxSearches: p.maxSearches,
        maxFetches: p.maxFetches,
      })),
      /** When the built-in list prices were captured; overrides are shown per model. */
      ratesCapturedAt: RATES_CAPTURED_AT,
      /** True when every call is forced to the offline provider. */
      mockMode: includeMock,
    };
  });

  app.get("/api/llm/providers", { preHandler: app.authenticate }, async () => {
    const providers: ProviderStatusDto[] = await ctx.credentials.status();
    return { providers };
  });

  /** Store or replace a provider's API key. The key is encrypted and never read back. */
  app.put("/api/llm/providers/:provider", { preHandler: app.requireRole("admin") }, async (req) => {
    const provider = parse(ProviderParamSchema, (req.params as { provider: string }).provider);
    const body = parse(ProviderCredentialSchema, req.body);
    await ctx.credentials.upsert(provider, body.apiKey.trim(), body.baseUrl?.trim() || null, req.user!.sub);
    if (ctx.llm instanceof LlmRouter) ctx.llm.invalidate();
    await ctx.audit.log({
      userId: req.user!.sub,
      userEmail: req.user!.email,
      action: "llm.provider_key_set",
      entityType: "llm_provider",
      entityId: provider,
      // Never log the key itself, only that one was set and which tail it ends with.
      metadata: { provider, keyHint: body.apiKey.trim().slice(-4), baseUrl: body.baseUrl || null },
      ip: req.ip,
    });
    return { providers: await ctx.credentials.status() };
  });

  app.delete("/api/llm/providers/:provider", { preHandler: app.requireRole("admin") }, async (req) => {
    const provider = parse(ProviderParamSchema, (req.params as { provider: string }).provider);
    await ctx.credentials.remove(provider);
    if (ctx.llm instanceof LlmRouter) ctx.llm.invalidate();
    await ctx.audit.log({
      userId: req.user!.sub,
      userEmail: req.user!.email,
      action: "llm.provider_key_removed",
      entityType: "llm_provider",
      entityId: provider,
      metadata: { provider },
      ip: req.ip,
    });
    return { providers: await ctx.credentials.status() };
  });

  /** Verify a stored key with the cheapest authenticated call each provider offers. */
  app.post("/api/llm/providers/:provider/test", { preHandler: app.requireRole("admin") }, async (req) => {
    const provider = parse(ProviderParamSchema, (req.params as { provider: string }).provider);
    const adapter = await ctx.llm.adapterFor(provider);
    if (!adapter) throw AppError.badRequest(`No API key is configured for ${PROVIDER_LABELS[provider]}`);
    if (!adapter.ping) return { ok: true, message: "This provider has no connectivity check." };
    try {
      await adapter.ping();
      await ctx.credentials.recordTest(provider, true, null).catch(() => {});
      return { ok: true, message: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.credentials.recordTest(provider, false, message).catch(() => {});
      return { ok: false, message };
    }
  });

  /**
   * Cost of a hypothetical campaign, for the "what will this cost?" panel on the new-campaign
   * form, where no campaign row exists yet.
   */
  app.post("/api/llm/estimate", { preHandler: app.authenticate }, async (req) => {
    const body = parse(
      z.object({
        leads: z.number().int().min(0).max(1_000_000),
        steps: z.number().int().min(1).max(8).default(1),
        researchModel: z.string().max(120).optional(),
        draftModel: z.string().max(120).optional(),
        researchMode: z.enum(["normal", "great", "advance"]).optional(),
      }),
      req.body,
    );
    const settings = await ctx.settings.get();
    // Deliberately not mock-substituted: this answers "what would the selected model cost",
    // which must be the real model's price even on a deployment running offline.
    const research = resolveModel(body.researchModel ?? settings.researchModel, settings);
    const draft = resolveModel(body.draftModel ?? settings.llmModel, settings);
    const estimate = estimateCost({
      leadsToResearch: body.leads,
      emailsToDraft: body.leads * body.steps,
      researchMode: body.researchMode ?? settings.researchMode,
      researchRates: research.rates,
      draftRates: draft.rates,
    });
    return {
      estimate,
      ai: {
        researchModel: research.choice.value,
        researchModelLabel: research.label,
        researchBatch: research.batch,
        draftModel: draft.choice.value,
        draftModelLabel: draft.label,
        draftBatch: draft.batch,
        researchMode: body.researchMode ?? settings.researchMode,
        batchStrategy: settings.batchStrategy,
        overridden: [],
        usesBatch: research.batch || draft.batch,
      },
      /** Whether both chosen models can actually run right now. */
      ready: {
        research: (await ctx.credentials.resolve(research.provider)) !== null,
        draft: (await ctx.credentials.resolve(draft.provider)) !== null,
      },
    };
  });

  // ----- batches -----

  app.get("/api/llm/batches", { preHandler: app.authenticate }, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(BATCH_STATUSES).optional(),
        campaignId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const conds = [];
    if (q.status) conds.push(eq(llmBatches.status, q.status));
    if (q.campaignId) conds.push(eq(llmBatches.campaignId, q.campaignId));
    const rows = await ctx.db
      .select({ batch: llmBatches, campaignName: campaigns.name })
      .from(llmBatches)
      .leftJoin(campaigns, eq(campaigns.id, llmBatches.campaignId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(llmBatches.createdAt))
      .limit(q.limit);
    const items: BatchDto[] = rows.map(({ batch: b, campaignName }) => ({
      id: b.id,
      provider: b.provider,
      model: b.model,
      purpose: b.purpose,
      campaignId: b.campaignId,
      campaignName,
      externalId: b.externalId,
      status: b.status,
      strategy: b.strategy,
      requestCount: b.requestCount,
      succeeded: b.succeeded,
      errored: b.errored,
      microUsd: b.costMicroUsd,
      createdAt: b.createdAt.toISOString(),
      submittedAt: b.submittedAt?.toISOString() ?? null,
      completedAt: b.completedAt?.toISOString() ?? null,
      lastPolledAt: b.lastPolledAt?.toISOString() ?? null,
      error: b.error,
    }));
    const [pending] = await ctx.db
      .select({ n: llmBatchItems.id })
      .from(llmBatchItems)
      .where(inArray(llmBatchItems.status, ["pending"]))
      .limit(1);
    return { items, hasPending: Boolean(pending) };
  });

  /** Run the flush/poll tick now instead of waiting for the next scheduled one. */
  app.post("/api/llm/batches/tick", { preHandler: app.requireRole("admin") }, async (req) => {
    const result = await runBatchTick(ctx);
    await ctx.audit.log({
      userId: req.user!.sub,
      userEmail: req.user!.email,
      action: "llm.batch_tick",
      entityType: "llm_batch",
      entityId: "manual",
      metadata: result,
      ip: req.ip,
    });
    return result;
  });

  /** Cancel every open batch for a campaign; its leads fall back to synchronous jobs. */
  app.post("/api/llm/batches/cancel", { preHandler: app.requireRole("admin") }, async (req) => {
    const body = parse(z.object({ campaignId: z.string().uuid() }), req.body);
    const cancelled = await cancelCampaignBatches(ctx, body.campaignId);
    await ctx.audit.log({
      userId: req.user!.sub,
      userEmail: req.user!.email,
      action: "llm.batches_cancelled",
      entityType: "campaign",
      entityId: body.campaignId,
      metadata: { cancelled },
      ip: req.ip,
    });
    return { cancelled };
  });
}

export { CONFIGURABLE_PROVIDERS, type BatchStatus, type ConfigurableProvider };
