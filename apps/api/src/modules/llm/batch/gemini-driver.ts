import { JobState, type GoogleGenAI, type InlinedRequest } from "@google/genai";
import { ZERO_USAGE, type BatchStatus } from "@mailapp/shared";
import { geminiTextOf, geminiUsageOf } from "../gemini.js";
import type { BatchDriver, BatchItemResult, BatchSubmission, PollResult, SubmitResult } from "./driver.js";

function mapStatus(state: JobState | undefined): BatchStatus {
  switch (state) {
    case JobState.JOB_STATE_QUEUED:
    case JobState.JOB_STATE_PENDING:
      return "submitted";
    case JobState.JOB_STATE_RUNNING:
    case JobState.JOB_STATE_UPDATING:
    case JobState.JOB_STATE_PAUSED:
    case JobState.JOB_STATE_CANCELLING:
      return "processing";
    case JobState.JOB_STATE_SUCCEEDED:
    case JobState.JOB_STATE_PARTIALLY_SUCCEEDED:
      return "completed";
    case JobState.JOB_STATE_FAILED:
      return "failed";
    case JobState.JOB_STATE_CANCELLED:
      return "cancelled";
    case JobState.JOB_STATE_EXPIRED:
      return "expired";
    default:
      return "submitted";
  }
}

/**
 * Gemini batch mode with inlined requests: no Cloud Storage needed, and the responses come
 * back inline in the same order as the requests. The per-request `metadata` carries our
 * custom id, and submission order is the fallback when a response omits it.
 */
export class GeminiBatchDriver implements BatchDriver {
  readonly provider = "gemini";

  constructor(private readonly client: GoogleGenAI) {}

  async submit(model: string, purpose: string, items: BatchSubmission[]): Promise<SubmitResult> {
    const requests: InlinedRequest[] = items.map((i) => {
      const body = i.body as { contents?: unknown; config?: Record<string, unknown> };
      return {
        contents: body.contents as never,
        config: body.config as never,
        metadata: { customId: i.customId },
      };
    });
    const job = await this.client.batches.create({
      model,
      src: { inlinedRequests: requests },
      config: { displayName: `outreach-${purpose}-${Date.now()}` },
    });
    if (!job.name) throw new Error("Gemini batch was created without a job name");
    // Order is the reliable key: inlinedResponses come back in request order.
    return { externalId: job.name, meta: { order: items.map((i) => i.customId) } };
  }

  async poll(externalId: string, meta: Record<string, unknown>): Promise<PollResult> {
    const job = await this.client.batches.get({ name: externalId });
    const status = mapStatus(job.state);
    if (status === "submitted" || status === "processing") return { status, results: [], error: null };

    const order = Array.isArray(meta.order) ? (meta.order as string[]) : [];
    const inlined = job.dest?.inlinedResponses ?? [];
    const results: BatchItemResult[] = [];
    inlined.forEach((item, index) => {
      const customId = item.metadata?.customId ?? order[index];
      if (!customId) return;
      if (item.error || !item.response) {
        results.push({
          customId,
          ok: false,
          text: null,
          usage: ZERO_USAGE,
          stopReason: null,
          error: item.error?.message ?? "no response returned",
        });
        return;
      }
      const text = geminiTextOf(item.response);
      results.push({
        customId,
        ok: text.trim().length > 0,
        text,
        usage: geminiUsageOf(item.response),
        stopReason: item.response.candidates?.[0]?.finishReason ?? null,
        error: text.trim() ? null : "empty response",
      });
    });
    return {
      status: status === "failed" && results.length > 0 ? "completed" : status,
      results,
      error: status === "failed" ? (job.error?.message ?? "batch failed") : null,
    };
  }

  async cancel(externalId: string): Promise<void> {
    await this.client.batches.cancel({ name: externalId });
  }
}
