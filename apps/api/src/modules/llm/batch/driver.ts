import type { BatchStatus, TokenUsage } from "@mailapp/shared";

/** One request handed to a provider's batch endpoint. */
export interface BatchSubmission {
  customId: string;
  body: Record<string, unknown>;
}

export interface SubmitResult {
  externalId: string;
  /** Provider-specific handles we must keep to poll and read results back. */
  meta: Record<string, unknown>;
}

/** One result read back from a finished batch. */
export interface BatchItemResult {
  customId: string;
  ok: boolean;
  /** The parsed model output text (JSON for our structured calls). */
  text: string | null;
  usage: TokenUsage;
  stopReason: string | null;
  error: string | null;
  /** Set when the provider reports this request as expired rather than failed. */
  expired?: boolean;
}

export interface PollResult {
  status: BatchStatus;
  /** Present once the batch has ended; empty while still processing. */
  results: BatchItemResult[];
  error: string | null;
}

/**
 * A provider's batch endpoint, reduced to the three operations the tick needs. Providers
 * whose batch shapes differ wildly (a JSONL upload for OpenAI, inline requests for Gemini)
 * hide that behind this interface.
 */
export interface BatchDriver {
  readonly provider: string;
  submit(model: string, purpose: string, items: BatchSubmission[]): Promise<SubmitResult>;
  poll(externalId: string, meta: Record<string, unknown>): Promise<PollResult>;
  cancel(externalId: string, meta: Record<string, unknown>): Promise<void>;
}

/** Map a provider's own status string onto our lifecycle. */
export function terminal(status: BatchStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "expired";
}
