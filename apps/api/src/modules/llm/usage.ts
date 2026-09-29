import { eq, sql } from "drizzle-orm";
import { ZERO_USAGE, costMicroUsd, type LlmPurpose, type TokenUsage } from "@mailapp/shared";
import type { Db } from "../../db/client.js";
import { emails, leads, llmCalls } from "../../db/schema.js";
import type { Logger } from "../../observability/logger.js";
import type { MetricsSink } from "../../observability/metrics.js";
import type { ResolvedModel } from "./catalogue.js";

export interface RecordCallInput {
  purpose: LlmPurpose;
  model: ResolvedModel;
  usage: TokenUsage;
  durationMs: number;
  stopReason: string | null;
  ok: boolean;
  error: string | null;
  leadId?: string | null;
  campaignId?: string | null;
  emailId?: string | null;
  /** Supply when the cost was already computed (batch results price the whole item). */
  costMicroUsd?: number;
}

/**
 * Persist one model call with the cost it was charged, and keep the lead-level rollups in
 * step. Recording must never break the pipeline, so failures are logged and swallowed —
 * the call itself already happened and the money is already spent.
 */
export async function recordLlmCall(
  deps: { db: Db; logger: Logger; metrics: MetricsSink },
  input: RecordCallInput,
): Promise<number> {
  const usage = input.usage ?? ZERO_USAGE;
  const cost = input.costMicroUsd ?? costMicroUsd(usage, input.model.rates);
  const tags = { purpose: input.purpose, provider: input.model.provider, batch: String(input.model.batch) };

  deps.metrics.emit("llm_calls", 1, tags);
  deps.metrics.timing("llm_latency_ms", input.durationMs, { purpose: input.purpose });
  deps.metrics.emit("llm_input_tokens", usage.inputTokens + usage.cacheReadTokens, tags);
  deps.metrics.emit("llm_output_tokens", usage.outputTokens, tags);
  deps.metrics.emit("llm_cost_micro_usd", cost, tags);
  if (!input.ok) deps.metrics.emit("llm_failures", 1, tags);

  try {
    await deps.db.insert(llmCalls).values({
      leadId: input.leadId ?? undefined,
      campaignId: input.campaignId ?? undefined,
      emailId: input.emailId ?? undefined,
      purpose: input.purpose,
      provider: input.model.provider,
      modelKey: input.model.modelKey,
      model: input.model.model,
      batch: input.model.batch,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costMicroUsd: cost,
      durationMs: input.durationMs,
      stopReason: input.stopReason,
      ok: input.ok,
      error: input.error,
    });
    // A failed call still consumed tokens on some providers, so roll it up either way.
    if (input.leadId && cost > 0) {
      const isResearch = input.purpose === "research" || input.purpose === "persona";
      await deps.db
        .update(leads)
        .set({
          totalCostMicroUsd: sql`${leads.totalCostMicroUsd} + ${cost}`,
          ...(isResearch ? { researchCostMicroUsd: sql`${leads.researchCostMicroUsd} + ${cost}` } : {}),
        })
        .where(eq(leads.id, input.leadId));
    }
    if (input.emailId && cost > 0) {
      await deps.db
        .update(emails)
        .set({ costMicroUsd: sql`${emails.costMicroUsd} + ${cost}` })
        .where(eq(emails.id, input.emailId));
    }
  } catch (err) {
    deps.logger.warn({ err, purpose: input.purpose }, "failed to record llm call");
  }
  return cost;
}

/**
 * Attribute already-recorded drafting cost to the email row the draft produced. The draft
 * call is recorded before the email exists (it is what decides the email's content), so the
 * link is filled in afterwards.
 */
export async function attachCostToEmail(
  deps: { db: Db; logger: Logger },
  opts: { leadId: string; step: number; emailId: string; costMicroUsd: number },
): Promise<void> {
  if (opts.costMicroUsd <= 0) return;
  try {
    await deps.db.update(emails).set({ costMicroUsd: opts.costMicroUsd }).where(eq(emails.id, opts.emailId));
    await deps.db
      .update(llmCalls)
      .set({ emailId: opts.emailId })
      .where(
        sql`${llmCalls.leadId} = ${opts.leadId} and ${llmCalls.purpose} = 'draft' and ${llmCalls.emailId} is null`,
      );
  } catch (err) {
    deps.logger.warn({ err, emailId: opts.emailId }, "failed to attribute draft cost to email");
  }
}
