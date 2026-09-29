import type OpenAI from "openai";
import { ZERO_USAGE, type BatchStatus, type TokenUsage } from "@mailapp/shared";
import { chatUsage, describeOpenAiError, responsesUsage } from "../openai.js";
import type { BatchDriver, BatchItemResult, BatchSubmission, PollResult, SubmitResult } from "./driver.js";

function mapStatus(s: OpenAI.Batch["status"]): BatchStatus {
  switch (s) {
    case "validating":
      return "submitted";
    case "in_progress":
    case "finalizing":
    case "cancelling":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    default:
      return "submitted";
  }
}

interface OutputLine {
  custom_id?: string;
  response?: { status_code?: number; body?: Record<string, unknown> };
  error?: { message?: string; code?: string } | null;
}

/** Pull text and usage out of either response shape, so one driver serves both endpoints. */
function readBody(body: Record<string, unknown> | undefined, endpoint: string): { text: string; usage: TokenUsage; stopReason: string | null } {
  if (!body) return { text: "", usage: ZERO_USAGE, stopReason: null };
  if (endpoint === "/v1/responses") {
    const r = body as { output_text?: string; output?: unknown; status?: string; usage?: never };
    // Batch output carries the full Response object; output_text is only added by the SDK,
    // so reconstruct it from the output blocks when it is absent.
    const text = r.output_text ?? collectResponseText(r.output);
    return { text, usage: responsesUsage(body.usage as never), stopReason: (r.status as string | undefined) ?? null };
  }
  const c = body as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  return {
    text: c.choices?.[0]?.message?.content ?? "",
    usage: chatUsage(body.usage as never),
    stopReason: c.choices?.[0]?.finish_reason ?? null,
  };
}

function collectResponseText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; text?: string };
      if (b.type === "output_text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/**
 * OpenAI Batch: requests are uploaded as a JSONL file, the batch references that file, and
 * results come back as another file of JSONL lines keyed by custom_id. 24-hour window, 50%
 * of list price.
 */
export class OpenAiBatchDriver implements BatchDriver {
  readonly provider = "openai";

  constructor(
    private readonly client: OpenAI,
    private readonly endpoint: "/v1/responses" | "/v1/chat/completions",
  ) {}

  async submit(_model: string, purpose: string, items: BatchSubmission[]): Promise<SubmitResult> {
    const jsonl = items
      .map((i) => JSON.stringify({ custom_id: i.customId, method: "POST", url: this.endpoint, body: i.body }))
      .join("\n");
    const file = await this.client.files.create({
      file: new File([jsonl], `outreach-${purpose}-${Date.now()}.jsonl`, { type: "application/jsonl" }),
      purpose: "batch",
    });
    const batch = await this.client.batches.create({
      completion_window: "24h",
      endpoint: this.endpoint,
      input_file_id: file.id,
      metadata: { purpose },
    });
    return { externalId: batch.id, meta: { inputFileId: file.id, endpoint: this.endpoint } };
  }

  async poll(externalId: string, meta: Record<string, unknown>): Promise<PollResult> {
    const batch = await this.client.batches.retrieve(externalId);
    const status = mapStatus(batch.status);
    if (status === "submitted" || status === "processing") return { status, results: [], error: null };

    const endpoint = (meta.endpoint as string) ?? this.endpoint;
    const results: BatchItemResult[] = [];
    // A failed batch may still have an error file with per-request detail.
    for (const fileId of [batch.output_file_id, batch.error_file_id]) {
      if (!fileId) continue;
      const content = await this.client.files.content(fileId);
      const text = await content.text();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let parsed: OutputLine;
        try {
          parsed = JSON.parse(line) as OutputLine;
        } catch {
          continue;
        }
        if (!parsed.custom_id) continue;
        const code = parsed.response?.status_code ?? 0;
        if (parsed.error || code >= 400 || !parsed.response?.body) {
          results.push({
            customId: parsed.custom_id,
            ok: false,
            text: null,
            usage: ZERO_USAGE,
            stopReason: null,
            error: parsed.error?.message ?? `HTTP ${code || "error"}`,
          });
          continue;
        }
        const { text: out, usage, stopReason } = readBody(parsed.response.body, endpoint);
        results.push({
          customId: parsed.custom_id,
          ok: out.trim().length > 0,
          text: out,
          usage,
          stopReason,
          error: out.trim() ? null : "empty response",
        });
      }
    }
    const failure = status === "failed" ? (batch.errors?.data?.[0]?.message ?? "batch failed") : null;
    return { status: status === "failed" && results.length > 0 ? "completed" : status, results, error: failure };
  }

  async cancel(externalId: string): Promise<void> {
    await this.client.batches.cancel(externalId);
  }
}

export { describeOpenAiError as describeOpenAiBatchError };
