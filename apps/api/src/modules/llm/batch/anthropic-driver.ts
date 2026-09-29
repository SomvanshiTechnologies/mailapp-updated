import type Anthropic from "@anthropic-ai/sdk";
import { ZERO_USAGE, type BatchStatus } from "@mailapp/shared";
import { describeError } from "../anthropic.js";
import type { BatchDriver, BatchItemResult, BatchSubmission, PollResult, SubmitResult } from "./driver.js";

function mapStatus(s: string, counts: { processing: number } | undefined): BatchStatus {
  if (s === "ended") return "completed";
  if (s === "canceling") return "processing";
  return counts && counts.processing > 0 ? "processing" : "submitted";
}

function usageOf(u: Anthropic.Usage | undefined) {
  if (!u) return ZERO_USAGE;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Anthropic Message Batches: requests go inline, results stream back as JSONL keyed by
 * custom_id. Batches usually finish well inside an hour and expire after 24.
 */
export class AnthropicBatchDriver implements BatchDriver {
  readonly provider = "anthropic";

  constructor(private readonly client: Anthropic) {}

  async submit(_model: string, _purpose: string, items: BatchSubmission[]): Promise<SubmitResult> {
    const batch = await this.client.messages.batches.create({
      requests: items.map((i) => ({ custom_id: i.customId, params: i.body as never })),
    });
    return { externalId: batch.id, meta: {} };
  }

  async poll(externalId: string): Promise<PollResult> {
    const batch = await this.client.messages.batches.retrieve(externalId);
    const status = mapStatus(batch.processing_status, batch.request_counts);
    if (status !== "completed") return { status, results: [], error: null };

    const results: BatchItemResult[] = [];
    for await (const row of await this.client.messages.batches.results(externalId)) {
      const r = row.result;
      if (r.type === "succeeded") {
        const msg = r.message;
        const text = msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        results.push({
          customId: row.custom_id,
          ok: msg.stop_reason !== "refusal" && text.trim().length > 0,
          text,
          usage: usageOf(msg.usage),
          stopReason: msg.stop_reason ?? null,
          error: msg.stop_reason === "refusal" ? "model refused the request" : text.trim() ? null : "empty response",
        });
      } else if (r.type === "expired") {
        results.push({ customId: row.custom_id, ok: false, text: null, usage: ZERO_USAGE, stopReason: null, error: "expired", expired: true });
      } else {
        const message = r.type === "errored" ? describeBatchError(r.error) : r.type;
        results.push({ customId: row.custom_id, ok: false, text: null, usage: ZERO_USAGE, stopReason: null, error: message });
      }
    }
    return { status: "completed", results, error: null };
  }

  async cancel(externalId: string): Promise<void> {
    await this.client.messages.batches.cancel(externalId);
  }
}

function describeBatchError(err: unknown): string {
  const e = err as { type?: string; error?: { type?: string; message?: string } } | undefined;
  if (e?.error?.message) return `${e.error.type ?? "error"}: ${e.error.message}`;
  return describeError(err);
}
