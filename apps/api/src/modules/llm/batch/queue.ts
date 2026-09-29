import { JOB_QUEUES, type BatchStrategy, type LlmPurpose } from "@mailapp/shared";
import type { AppContext } from "../../../context.js";
import { llmBatchItems, type LeadRow } from "../../../db/schema.js";
import type { ResolvedModel } from "../catalogue.js";
import type { LlmAdapter, PreparedRequest } from "../provider.js";

export interface QueueBatchItemInput {
  purpose: LlmPurpose;
  lead: LeadRow;
  campaignId: string;
  model: ResolvedModel;
  strategy: BatchStrategy;
  /** 0 for research; the sequence step for drafts. */
  step: number;
  attempt: number;
  /** Builds the provider request. Returns null when the adapter cannot batch this purpose. */
  prepare: (adapter: LlmAdapter) => Promise<PreparedRequest | null>;
  /** Extra data the runner needs to apply the result. */
  context?: Record<string, unknown>;
}

/**
 * Add one request to the pending batch queue.
 *
 * Returns false when the work cannot be batched after all — no key for the provider, or the
 * adapter has no batch support — so the caller can fall back to a synchronous call rather
 * than leaving the lead stuck.
 *
 * The unique index on (lead, purpose, step, attempt) makes this idempotent: a retried job
 * re-queues nothing and cannot double-charge.
 */
export async function queueBatchItem(ctx: AppContext, input: QueueBatchItemInput): Promise<boolean> {
  const adapter = await ctx.llm.adapterFor(input.model.provider);
  if (!adapter) return false;
  let prepared: PreparedRequest | null;
  try {
    prepared = await input.prepare(adapter);
  } catch (err) {
    ctx.logger.warn({ err, purpose: input.purpose, leadId: input.lead.id }, "failed to build batch request");
    return false;
  }
  if (!prepared) return false;

  const customId = customIdFor(input.purpose, input.lead.id, input.step, input.attempt);
  const inserted = await ctx.db
    .insert(llmBatchItems)
    .values({
      campaignId: input.campaignId,
      leadId: input.lead.id,
      customId,
      purpose: input.purpose,
      provider: input.model.provider,
      modelKey: input.model.modelKey,
      model: input.model.model,
      step: input.step,
      attempt: input.attempt,
      status: "pending",
      payload: prepared.body,
      context: input.context ?? null,
    })
    .onConflictDoNothing({ target: [llmBatchItems.leadId, llmBatchItems.purpose, llmBatchItems.step, llmBatchItems.attempt] })
    .returning({ id: llmBatchItems.id });

  if (!inserted.length) {
    ctx.logger.debug({ customId }, "batch item already queued");
    return true;
  }
  ctx.metrics.emit("llm_batch_items_queued", 1, { purpose: input.purpose, provider: input.model.provider });

  // "One batch per campaign" wants the tick to run as soon as the enqueue burst settles;
  // rolling batches wait for the flush window, which the scheduled tick already covers.
  if (input.strategy === "campaign_start") {
    await ctx.queue.publish(
      JOB_QUEUES.llmBatchTick,
      {},
      { singletonKey: `llm.batch.tick:${input.campaignId}`, startAfter: 30, retryLimit: 2 },
    );
  }
  return true;
}

/** "<purpose>:<leadId>:<step>:<attempt>" — unique inside a batch and parseable on the way back. */
export function customIdFor(purpose: LlmPurpose, leadId: string, step: number, attempt: number): string {
  return `${purpose}:${leadId}:${step}:${attempt}`;
}

export function parseCustomId(customId: string): { purpose: LlmPurpose; leadId: string; step: number; attempt: number } | null {
  const parts = customId.split(":");
  if (parts.length !== 4) return null;
  const [purpose, leadId, step, attempt] = parts;
  if (purpose !== "research" && purpose !== "persona" && purpose !== "draft") return null;
  const stepNum = Number(step);
  const attemptNum = Number(attempt);
  if (!Number.isInteger(stepNum) || !Number.isInteger(attemptNum)) return null;
  return { purpose, leadId, step: stepNum, attempt: attemptNum };
}
