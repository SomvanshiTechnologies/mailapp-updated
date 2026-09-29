import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  DraftOutputSchema,
  JOB_QUEUES,
  OPEN_BATCH_STATUSES,
  PersonaSchema,
  ZERO_USAGE,
  costMicroUsd,
  type BatchStatus,
  type BatchStrategy,
  type LlmPurpose,
  type Persona,
} from "@mailapp/shared";
import type { AppContext } from "../../../context.js";
import { campaigns, leads, llmBatchItems, llmBatches, type LlmBatchItemRow, type LlmBatchRow } from "../../../db/schema.js";
import type { DraftJob } from "../../../jobs/types.js";
import {
  MAX_DRAFT_ATTEMPTS,
  applyDraftResult,
  draftAlreadyExists,
  prepareDraft,
  validatorFeedback,
  type PreparedDraft,
} from "../../pipeline/draft.js";
import { applyResearchResult, failLead, prepareResearch } from "../../pipeline/research.js";
import { validateDraft } from "../../pipeline/validator.js";
import { resolveModel } from "../catalogue.js";
import { MockLlmAdapter } from "../mock.js";
import { parseOpenAiJson } from "../openai.js";
import { OpenAiAdapter } from "../openai.js";
import { GeminiAdapter } from "../gemini.js";
import { AnthropicAdapter } from "../anthropic.js";
import { recordLlmCall } from "../usage.js";
import { AnthropicBatchDriver } from "./anthropic-driver.js";
import { GeminiBatchDriver } from "./gemini-driver.js";
import { OpenAiBatchDriver } from "./openai-driver.js";
import type { BatchDriver, BatchItemResult } from "./driver.js";
import { parseCustomId, queueBatchItem } from "./queue.js";

/**
 * The batch tick. Runs once a minute (and on demand after a campaign-start burst):
 *   1. flush — group pending items and submit each group as one provider batch
 *   2. poll  — check open batches and apply whatever has landed
 * Both halves are bounded per run so one huge campaign cannot starve the queue.
 */
export async function runBatchTick(ctx: AppContext): Promise<{ submitted: number; polled: number; applied: number }> {
  const submitted = await flushPending(ctx);
  const { polled, applied } = await pollOpenBatches(ctx);
  return { submitted, polled, applied };
}

/** Build the driver for a provider, or null when it has no key or no batch endpoint. */
async function driverFor(ctx: AppContext, provider: string): Promise<BatchDriver | null> {
  const adapter = await ctx.llm.adapterFor(provider);
  if (!adapter) return null;
  if (adapter instanceof AnthropicAdapter) {
    return new AnthropicBatchDriver(adapter.raw);
  }
  if (adapter instanceof OpenAiAdapter) {
    // DeepSeek speaks chat completions but has no batch endpoint at all.
    if (adapter.provider !== "openai") return null;
    return new OpenAiBatchDriver(adapter.raw, adapter.surface === "responses" ? "/v1/responses" : "/v1/chat/completions");
  }
  if (adapter instanceof GeminiAdapter) return new GeminiBatchDriver(adapter.raw);
  return null;
}

// ---------- flush ----------

interface PendingGroup {
  campaignId: string;
  purpose: LlmPurpose;
  provider: string;
  modelKey: string;
  model: string;
  count: number;
  oldest: Date;
}

/**
 * Submit pending items as provider batches.
 *
 * A group is flushed when either trigger fires: the oldest queued request is older than the
 * flush window, or the group has reached the size cap. Campaign-start groups also flush once
 * the enqueue burst has gone quiet, which is what makes "one batch per campaign" one batch.
 */
export async function flushPending(ctx: AppContext): Promise<number> {
  const settings = await ctx.settings.get();
  const groups = await ctx.db
    .select({
      campaignId: llmBatchItems.campaignId,
      purpose: llmBatchItems.purpose,
      provider: llmBatchItems.provider,
      modelKey: llmBatchItems.modelKey,
      model: llmBatchItems.model,
      count: sql<number>`count(*)::int`,
      oldest: sql<Date>`min(${llmBatchItems.queuedAt})`,
      newest: sql<Date>`max(${llmBatchItems.queuedAt})`,
    })
    .from(llmBatchItems)
    .where(and(eq(llmBatchItems.status, "pending"), isNull(llmBatchItems.batchId)))
    .groupBy(llmBatchItems.campaignId, llmBatchItems.purpose, llmBatchItems.provider, llmBatchItems.modelKey, llmBatchItems.model)
    .orderBy(asc(sql`min(${llmBatchItems.queuedAt})`))
    .limit(ctx.config.LLM_BATCH_MAX_PER_TICK * 2);

  const now = Date.now();
  const flushMs = settings.batchFlushMinutes * 60_000;
  // Campaign-start groups only need the enqueue burst to settle, not the full window.
  const QUIET_MS = 30_000;
  let submitted = 0;

  for (const g of groups) {
    if (submitted >= ctx.config.LLM_BATCH_MAX_PER_TICK) break;
    const strategy = await strategyFor(ctx, g.campaignId);
    const oldestMs = new Date(g.oldest).getTime();
    const newestMs = new Date(g.newest).getTime();
    const ready =
      g.count >= settings.batchMaxRequests ||
      (strategy === "campaign_start" ? now - newestMs >= QUIET_MS : now - oldestMs >= flushMs);
    if (!ready) continue;
    try {
      const ok = await submitGroup(ctx, g as PendingGroup, strategy, settings.batchMaxRequests);
      if (ok) submitted++;
    } catch (err) {
      ctx.logger.error({ err, group: { campaignId: g.campaignId, purpose: g.purpose, model: g.modelKey } }, "batch submit failed");
    }
  }
  return submitted;
}

/** The batch strategy the campaign resolves to. */
async function strategyFor(ctx: AppContext, campaignId: string): Promise<BatchStrategy> {
  const settings = await ctx.settings.get();
  const [row] = await ctx.db.select({ aiConfig: campaigns.aiConfig }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  return row?.aiConfig?.batchStrategy ?? settings.batchStrategy;
}

async function submitGroup(ctx: AppContext, g: PendingGroup, strategy: BatchStrategy, maxRequests: number): Promise<boolean> {
  const items = await ctx.db
    .select()
    .from(llmBatchItems)
    .where(
      and(
        eq(llmBatchItems.status, "pending"),
        isNull(llmBatchItems.batchId),
        eq(llmBatchItems.campaignId, g.campaignId),
        eq(llmBatchItems.purpose, g.purpose),
        eq(llmBatchItems.modelKey, g.modelKey),
      ),
    )
    .orderBy(asc(llmBatchItems.queuedAt))
    .limit(maxRequests);
  if (!items.length) return false;

  // The mock provider has no batch endpoint: run its items inline so the state machine is
  // exercisable end to end without a network.
  const adapter = await ctx.llm.adapterFor(g.provider);
  if (adapter instanceof MockLlmAdapter) {
    const [batch] = await ctx.db
      .insert(llmBatches)
      .values({
        campaignId: g.campaignId,
        provider: "mock",
        modelKey: g.modelKey,
        model: g.model,
        purpose: g.purpose,
        strategy,
        status: "completed",
        externalId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        requestCount: items.length,
        submittedAt: new Date(),
        completedAt: new Date(),
      })
      .returning();
    await ctx.db
      .update(llmBatchItems)
      .set({ batchId: batch.id, status: "submitted" })
      .where(inArray(llmBatchItems.id, items.map((i) => i.id)));
    await runMockBatch(ctx, batch, items);
    return true;
  }

  const driver = await driverFor(ctx, g.provider);
  if (!driver) {
    // No key, or the provider cannot batch. Fall the items back to synchronous jobs rather
    // than leaving the leads waiting for a batch that will never be submitted.
    ctx.logger.warn({ provider: g.provider, purpose: g.purpose }, "no batch driver available; falling back to synchronous jobs");
    await fallbackToSync(ctx, items);
    return false;
  }

  const [batch] = await ctx.db
    .insert(llmBatches)
    .values({
      campaignId: g.campaignId,
      provider: g.provider as never,
      modelKey: g.modelKey,
      model: g.model,
      purpose: g.purpose,
      strategy,
      status: "pending",
      requestCount: items.length,
    })
    .returning();
  await ctx.db
    .update(llmBatchItems)
    .set({ batchId: batch.id })
    .where(inArray(llmBatchItems.id, items.map((i) => i.id)));

  try {
    const res = await driver.submit(
      g.model,
      g.purpose,
      items.map((i) => ({ customId: i.customId, body: i.payload })),
    );
    await ctx.db
      .update(llmBatches)
      .set({ status: "submitted", externalId: res.externalId, externalMeta: res.meta, submittedAt: new Date(), updatedAt: new Date() })
      .where(eq(llmBatches.id, batch.id));
    await ctx.db.update(llmBatchItems).set({ status: "submitted" }).where(eq(llmBatchItems.batchId, batch.id));
    ctx.metrics.emit("llm_batches_submitted", 1, { provider: g.provider, purpose: g.purpose });
    ctx.logger.info({ batchId: batch.id, externalId: res.externalId, items: items.length, purpose: g.purpose }, "batch submitted");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db
      .update(llmBatches)
      .set({ status: "failed", error: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(llmBatches.id, batch.id));
    // The requests were never accepted, so nothing was charged: retry them synchronously.
    await fallbackToSync(ctx, items);
    throw err;
  }
}

/** Abandon batch items and re-drive the leads through the ordinary synchronous jobs. */
async function fallbackToSync(ctx: AppContext, items: LlmBatchItemRow[]): Promise<void> {
  await ctx.db
    .update(llmBatchItems)
    .set({ status: "abandoned", error: "no batch endpoint available; ran synchronously", completedAt: new Date() })
    .where(inArray(llmBatchItems.id, items.map((i) => i.id)));
  for (const item of items) {
    if (item.purpose === "draft") {
      await ctx.queue.publish<DraftJob>(
        JOB_QUEUES.draft,
        { leadId: item.leadId, step: item.step },
        { singletonKey: `draft:${item.leadId}:${item.step}` },
      );
    } else {
      await ctx.queue.publish(JOB_QUEUES.research, { leadId: item.leadId }, { singletonKey: `research:${item.leadId}` });
    }
  }
}

// ---------- poll ----------

export async function pollOpenBatches(ctx: AppContext): Promise<{ polled: number; applied: number }> {
  const open = await ctx.db
    .select()
    .from(llmBatches)
    .where(inArray(llmBatches.status, [...OPEN_BATCH_STATUSES] as BatchStatus[]))
    .orderBy(asc(llmBatches.lastPolledAt))
    .limit(ctx.config.LLM_BATCH_MAX_PER_TICK);

  let polled = 0;
  let applied = 0;
  for (const batch of open) {
    if (!batch.externalId) continue;
    polled++;
    try {
      const driver = await driverFor(ctx, batch.provider);
      if (!driver) {
        ctx.logger.warn({ batchId: batch.id, provider: batch.provider }, "cannot poll batch: provider no longer configured");
        continue;
      }
      const res = await driver.poll(batch.externalId, batch.externalMeta ?? {});
      const attempts = batch.pollAttempts + 1;
      if (res.status === "submitted" || res.status === "processing") {
        // A batch that never finishes must not be polled forever.
        if (attempts >= ctx.config.LLM_BATCH_MAX_POLL_ATTEMPTS) {
          await abandonBatch(ctx, batch, "batch did not complete within the polling window");
          continue;
        }
        await ctx.db
          .update(llmBatches)
          .set({ status: res.status, lastPolledAt: new Date(), pollAttempts: attempts, updatedAt: new Date() })
          .where(eq(llmBatches.id, batch.id));
        continue;
      }
      applied += await applyBatchResults(ctx, batch, res.results, res.status, res.error);
    } catch (err) {
      ctx.logger.error({ err, batchId: batch.id }, "batch poll failed");
      await ctx.db
        .update(llmBatches)
        .set({
          lastPolledAt: new Date(),
          pollAttempts: batch.pollAttempts + 1,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
          updatedAt: new Date(),
        })
        .where(eq(llmBatches.id, batch.id));
    }
  }
  return { polled, applied };
}

/** Give up on a batch and push its leads back through the synchronous pipeline. */
async function abandonBatch(ctx: AppContext, batch: LlmBatchRow, reason: string): Promise<void> {
  const items = await ctx.db.select().from(llmBatchItems).where(eq(llmBatchItems.batchId, batch.id));
  await ctx.db
    .update(llmBatches)
    .set({ status: "failed", error: reason, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(llmBatches.id, batch.id));
  await fallbackToSync(
    ctx,
    items.filter((i) => i.status === "submitted" || i.status === "pending"),
  );
  ctx.logger.warn({ batchId: batch.id, reason, items: items.length }, "batch abandoned");
}

/**
 * Apply every result from a finished batch. One failing item must not stop the rest, so each
 * is wrapped; failures land on the lead as `lastError` exactly as a synchronous failure would.
 */
async function applyBatchResults(
  ctx: AppContext,
  batch: LlmBatchRow,
  results: BatchItemResult[],
  status: BatchStatus,
  batchError: string | null,
): Promise<number> {
  const items = await ctx.db.select().from(llmBatchItems).where(eq(llmBatchItems.batchId, batch.id));
  const byCustomId = new Map(items.map((i) => [i.customId, i]));
  let succeeded = 0;
  let errored = 0;
  let totalCost = 0;

  for (const result of results) {
    const item = byCustomId.get(result.customId);
    if (!item) {
      ctx.logger.warn({ batchId: batch.id, customId: result.customId }, "batch result for an unknown item");
      continue;
    }
    byCustomId.delete(result.customId);
    try {
      const cost = await applyOneResult(ctx, batch, item, result);
      totalCost += cost;
      if (result.ok) succeeded++;
      else errored++;
    } catch (err) {
      errored++;
      ctx.logger.error({ err, batchId: batch.id, customId: result.customId }, "failed to apply batch result");
      await ctx.db
        .update(llmBatchItems)
        .set({ status: "errored", error: (err instanceof Error ? err.message : String(err)).slice(0, 2000), completedAt: new Date() })
        .where(eq(llmBatchItems.id, item.id));
      await failLead(ctx, item.leadId, item.purpose, err instanceof Error ? err.message : String(err));
    }
  }

  // Items the provider never returned a result for: retry them synchronously.
  const missing = [...byCustomId.values()].filter((i) => i.status === "submitted" || i.status === "pending");
  if (missing.length) {
    ctx.logger.warn({ batchId: batch.id, missing: missing.length }, "batch ended without results for some items");
    await fallbackToSync(ctx, missing);
  }

  await ctx.db
    .update(llmBatches)
    .set({
      status,
      succeeded,
      errored,
      costMicroUsd: totalCost,
      completedAt: new Date(),
      lastPolledAt: new Date(),
      pollAttempts: batch.pollAttempts + 1,
      error: batchError,
      updatedAt: new Date(),
    })
    .where(eq(llmBatches.id, batch.id));
  ctx.metrics.emit("llm_batches_completed", 1, { provider: batch.provider, purpose: batch.purpose });
  ctx.logger.info({ batchId: batch.id, succeeded, errored, costMicroUsd: totalCost }, "batch results applied");
  return succeeded;
}

/** Record the spend for one item and drive the pipeline forward. Returns the cost charged. */
async function applyOneResult(ctx: AppContext, batch: LlmBatchRow, item: LlmBatchItemRow, result: BatchItemResult): Promise<number> {
  const settings = await ctx.settings.get();
  // Price with the batch discount: the row was submitted to a batch endpoint.
  const model = resolveModel(`${item.modelKey}@batch`, settings);
  const cost = costMicroUsd(result.usage ?? ZERO_USAGE, model.rates);

  await ctx.db
    .update(llmBatchItems)
    .set({
      status: result.expired ? "expired" : result.ok ? "succeeded" : "errored",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      costMicroUsd: cost,
      error: result.error,
      completedAt: new Date(),
    })
    .where(eq(llmBatchItems.id, item.id));

  await recordLlmCall(ctx, {
    purpose: item.purpose,
    model,
    usage: result.usage,
    durationMs: 0,
    stopReason: result.stopReason,
    ok: result.ok,
    error: result.error,
    leadId: item.leadId,
    campaignId: item.campaignId,
    costMicroUsd: cost,
  });

  if (!result.ok || !result.text) {
    // An expired request was never charged and deserves a retry; a genuine failure does not.
    if (result.expired) await fallbackToSync(ctx, [item]);
    else await failLead(ctx, item.leadId, item.purpose, result.error ?? "batch request produced no output");
    return cost;
  }

  if (item.purpose === "research") await applyBatchResearch(ctx, item, result, cost);
  else await applyBatchDraft(ctx, batch, item, result, cost);
  return cost;
}

async function applyBatchResearch(ctx: AppContext, item: LlmBatchItemRow, result: BatchItemResult, cost: number): Promise<void> {
  const persona: Persona = PersonaSchema.parse(parseOpenAiJson<unknown>(result.text!, "Persona"));
  const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, item.leadId)).limit(1);
  if (!lead) return;
  // The website extract was captured at queue time; the text body is not kept.
  const ctxData = (item.context ?? {}) as { website?: { url: string; title: string; fetchedAt: string; description?: string; headings?: string[] } | null };
  const website = ctxData.website
    ? {
        url: ctxData.website.url,
        title: ctxData.website.title,
        description: ctxData.website.description ?? "",
        headings: ctxData.website.headings ?? [],
        text: "",
        fetchedAt: ctxData.website.fetchedAt,
      }
    : null;
  await applyResearchResult(ctx, lead, website, {
    persona,
    notes: null,
    model: item.model,
    usage: result.usage,
    durationMs: 0,
  });
  ctx.logger.info({ leadId: item.leadId, costMicroUsd: cost }, "batched research applied");
}

async function applyBatchDraft(ctx: AppContext, batch: LlmBatchRow, item: LlmBatchItemRow, result: BatchItemResult, cost: number): Promise<void> {
  const output = DraftOutputSchema.parse(parseOpenAiJson<unknown>(result.text!, "Draft"));
  const ctxData = (item.context ?? {}) as { regenerate?: { emailId: string; feedback: string | null } | null; feedback?: string | null };
  const job: DraftJob = { leadId: item.leadId, step: item.step, ...(ctxData.regenerate ? { regenerate: ctxData.regenerate } : {}) };
  const prepared = await prepareDraft(ctx, job, { feedback: ctxData.feedback ?? null });
  if (!prepared || "completed" in prepared) {
    ctx.logger.info({ leadId: item.leadId }, "batched draft no longer applicable");
    return;
  }
  if (!job.regenerate) {
    const existing = await draftAlreadyExists(ctx, item.leadId, item.step);
    if (existing) return ctx.logger.info({ emailId: existing }, "draft already exists for step; discarding batch result");
  }

  const validation = validateDraft(output.subject, output.bodyText, prepared.hardRules, { toEmail: prepared.lead.email });
  if (!validation.ok && item.attempt < MAX_DRAFT_ATTEMPTS) {
    // Give the model the validator's feedback in a second batched request rather than falling
    // back to a full-price synchronous call.
    ctx.metrics.emit("drafts_rejected_by_validator");
    const feedback = validatorFeedback(validation);
    const retryInput = { ...prepared.input, regenerationFeedback: feedback };
    const queued = await queueBatchItem(ctx, {
      purpose: "draft",
      lead: prepared.lead,
      campaignId: item.campaignId,
      model: prepared.plan.draft,
      strategy: batch.strategy,
      step: item.step,
      attempt: item.attempt + 1,
      prepare: async (adapter) => adapter.prepareDraft?.(retryInput) ?? null,
      context: { regenerate: ctxData.regenerate ?? null, feedback },
    });
    if (queued) {
      ctx.logger.info({ leadId: item.leadId, step: item.step }, "batched draft failed validation; retry queued");
      return;
    }
  }

  await applyDraftResult(ctx, prepared as PreparedDraft, job, {
    output,
    model: item.model,
    usage: result.usage,
    durationMs: 0,
    attempt: item.attempt,
    costMicroUsd: cost,
    feedback: ctxData.feedback ?? null,
  });
  ctx.logger.info({ leadId: item.leadId, step: item.step, costMicroUsd: cost }, "batched draft applied");
}

// ---------- mock batches ----------

/** Execute a mock "batch" inline so the whole batch flow is testable without a provider. */
async function runMockBatch(ctx: AppContext, batch: LlmBatchRow, items: LlmBatchItemRow[]): Promise<void> {
  const results: BatchItemResult[] = [];
  for (const item of items) {
    const parsed = parseCustomId(item.customId);
    if (!parsed) continue;
    try {
      if (item.purpose === "research") {
        const prepared = await prepareResearch(ctx, item.leadId);
        if (!prepared) continue;
        const res = await ctx.llm.research(prepared.input);
        results.push({
          customId: item.customId,
          ok: true,
          text: JSON.stringify(res.output),
          usage: res.usage,
          stopReason: res.stopReason,
          error: null,
        });
      } else {
        const prepared = await prepareDraft(ctx, { leadId: item.leadId, step: item.step });
        if (!prepared || "completed" in prepared) continue;
        const res = await ctx.llm.draft(prepared.input);
        results.push({
          customId: item.customId,
          ok: true,
          text: JSON.stringify(res.output),
          usage: res.usage,
          stopReason: res.stopReason,
          error: null,
        });
      }
    } catch (err) {
      results.push({
        customId: item.customId,
        ok: false,
        text: null,
        usage: ZERO_USAGE,
        stopReason: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await applyBatchResults(ctx, batch, results, "completed", null);
}

/** Cancel every open batch for a campaign (used when a campaign is paused or archived). */
export async function cancelCampaignBatches(ctx: AppContext, campaignId: string): Promise<number> {
  const open = await ctx.db
    .select()
    .from(llmBatches)
    .where(and(eq(llmBatches.campaignId, campaignId), inArray(llmBatches.status, [...OPEN_BATCH_STATUSES] as BatchStatus[])));
  let cancelled = 0;
  for (const batch of open) {
    try {
      if (batch.externalId) {
        const driver = await driverFor(ctx, batch.provider);
        await driver?.cancel(batch.externalId, batch.externalMeta ?? {});
      }
      await ctx.db
        .update(llmBatches)
        .set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(llmBatches.id, batch.id));
      cancelled++;
    } catch (err) {
      ctx.logger.warn({ err, batchId: batch.id }, "failed to cancel batch");
    }
  }
  // Pending items that were never submitted can simply be dropped.
  await ctx.db
    .update(llmBatchItems)
    .set({ status: "abandoned", error: "campaign stopped", completedAt: new Date() })
    .where(
      and(
        eq(llmBatchItems.campaignId, campaignId),
        or(eq(llmBatchItems.status, "pending"), eq(llmBatchItems.status, "submitted")),
      ),
    );
  return cancelled;
}

/** Housekeeping: drop batch rows whose campaign is long gone. */
export async function pruneBatches(ctx: AppContext, olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const deleted = await ctx.db
    .delete(llmBatches)
    .where(and(lt(llmBatches.createdAt, cutoff), inArray(llmBatches.status, ["completed", "failed", "cancelled", "expired"])))
    .returning({ id: llmBatches.id });
  return deleted.length;
}
