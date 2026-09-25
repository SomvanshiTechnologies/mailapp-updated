import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AutoParseableOutputFormat } from "@anthropic-ai/sdk/lib/parser";
import type { ZodType } from "zod/v4";
import { DraftOutputSchema, PersonaSchema, type DraftOutput, type Persona } from "@mailapp/shared";
import { llmCalls } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import type { DraftInput, LlmDeps, LlmProvider, LlmResult, LlmUsage, ResearchInput } from "./provider.js";
import {
  PERSONA_STRUCTURE_SYSTEM,
  RESEARCH_SYSTEM,
  draftSystemBlocks,
  draftUserMessage,
  researchUserMessage,
} from "./prompts.js";

const MAX_RESEARCH_ITERATIONS = 6;

function usageOf(msg: Anthropic.Message): LlmUsage {
  return {
    inputTokens: msg.usage.input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

// The SDK converts schemas with zod/v4 at runtime but still types the parameter as a v3 ZodType.
function outputFormat<T>(schema: ZodType<T>): AutoParseableOutputFormat<T> {
  return zodOutputFormat(schema as never) as AutoParseableOutputFormat<T>;
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Claude-backed provider.
 * Research runs as an agentic loop with server-side web search/fetch, then the findings are
 * converted into a strict Persona JSON with structured outputs. Drafting is a single structured
 * call whose stable prefix (company profile, catalogue, tone/format/rules) is prompt-cached.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;
  private inflight = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly deps: LlmDeps) {
    this.client = new Anthropic({ apiKey: deps.config.ANTHROPIC_API_KEY || undefined, maxRetries: 3, timeout: 10 * 60_000 });
  }

  private async acquire(): Promise<() => void> {
    if (this.inflight >= this.deps.config.LLM_MAX_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inflight++;
    return () => {
      this.inflight--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  private async record(
    purpose: "research" | "draft",
    model: string,
    usage: LlmUsage,
    durationMs: number,
    stopReason: string | null,
    ok: boolean,
    error: string | null,
    ids: { leadId?: string; campaignId?: string },
  ): Promise<void> {
    this.deps.metrics.emit("llm_calls", 1, { purpose });
    this.deps.metrics.timing("llm_latency_ms", durationMs, { purpose });
    this.deps.metrics.emit("llm_input_tokens", usage.inputTokens + usage.cacheReadTokens, { purpose });
    this.deps.metrics.emit("llm_output_tokens", usage.outputTokens, { purpose });
    if (!ok) this.deps.metrics.emit("llm_failures", 1, { purpose });
    try {
      await this.deps.db.insert(llmCalls).values({
        leadId: ids.leadId,
        campaignId: ids.campaignId,
        purpose,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        durationMs,
        stopReason,
        ok,
        error,
      });
    } catch (err) {
      this.deps.logger.warn({ err }, "failed to record llm call");
    }
  }

  async research(input: ResearchInput): Promise<LlmResult<Persona>> {
    const release = await this.acquire();
    const started = Date.now();
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const ids = { leadId: input.lead.id, campaignId: input.lead.campaignId };
    try {
      // Phase 1: agentic research with server-side tools.
      const tools: Anthropic.ToolUnion[] = input.webSearch
        ? [
            { type: "web_search_20260209", name: "web_search", max_uses: 6 },
            { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 },
          ]
        : [];
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: researchUserMessage(input) }];
      let findings = "";
      let stopReason: string | null = null;
      for (let i = 0; i < MAX_RESEARCH_ITERATIONS; i++) {
        const res = await this.client.messages.create({
          model: input.model,
          max_tokens: 16000,
          system: RESEARCH_SYSTEM,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          tools: tools.length ? tools : undefined,
          messages,
        });
        usage = addUsage(usage, usageOf(res));
        stopReason = res.stop_reason;
        if (res.stop_reason === "refusal") {
          throw new AppError("llm_refusal", "Research request was refused by the model", 502);
        }
        if (res.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: res.content });
          continue;
        }
        findings = textOf(res);
        break;
      }
      if (!findings.trim()) throw new AppError("llm_empty", "Research produced no findings", 502);

      // Phase 2: structure the findings.
      const parsed = await this.client.messages.parse({
        model: input.model,
        max_tokens: 8000,
        system: PERSONA_STRUCTURE_SYSTEM,
        output_config: { format: outputFormat(PersonaSchema), effort: "low" },
        messages: [
          {
            role: "user",
            content: `Research findings for ${input.lead.company ?? input.lead.email}:\n\n${findings}\n\nConvert these findings into the persona JSON.`,
          },
        ],
      });
      usage = addUsage(usage, usageOf(parsed));
      if (parsed.stop_reason === "refusal") {
        throw new AppError("llm_refusal", "Persona structuring refused", 502);
      }
      const persona = parsed.parsed_output;
      if (!persona) throw new AppError("llm_parse", "Persona output did not match schema", 502);
      const durationMs = Date.now() - started;
      await this.record("research", input.model, usage, durationMs, stopReason, true, null, ids);
      return { output: persona, model: input.model, usage, durationMs, stopReason, notes: findings };
    } catch (err) {
      const durationMs = Date.now() - started;
      await this.record("research", input.model, usage, durationMs, null, false, describeError(err), ids);
      throw normaliseError(err);
    } finally {
      release();
    }
  }

  async draft(input: DraftInput): Promise<LlmResult<DraftOutput>> {
    const release = await this.acquire();
    const started = Date.now();
    const ids = { leadId: input.lead.id, campaignId: input.lead.campaignId };
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    try {
      const blocks = draftSystemBlocks(input.instructions, input.services, input.hardRules);
      const system: Anthropic.TextBlockParam[] = blocks.map((text, i) => ({
        type: "text",
        text,
        // Cache the whole stable prefix; it is identical for every lead in a campaign.
        ...(i === blocks.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
      }));
      const res = await this.client.messages.parse({
        model: input.model,
        max_tokens: 8000,
        system,
        thinking: { type: "adaptive" },
        output_config: { format: outputFormat(DraftOutputSchema) },
        messages: [{ role: "user", content: draftUserMessage(input) }],
      });
      usage = usageOf(res);
      if (res.stop_reason === "refusal") {
        throw new AppError("llm_refusal", "Draft request was refused by the model", 502);
      }
      const out = res.parsed_output;
      if (!out) throw new AppError("llm_parse", "Draft output did not match schema", 502);
      const durationMs = Date.now() - started;
      await this.record("draft", input.model, usage, durationMs, res.stop_reason, true, null, ids);
      return { output: out, model: input.model, usage, durationMs, stopReason: res.stop_reason };
    } catch (err) {
      const durationMs = Date.now() - started;
      await this.record("draft", input.model, usage, durationMs, null, false, describeError(err), ids);
      throw normaliseError(err);
    } finally {
      release();
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.name} ${err.status}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function normaliseError(err: unknown): Error {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AppError("llm_auth", "Anthropic API key rejected", 502);
  if (err instanceof Anthropic.RateLimitError) return new AppError("llm_rate_limited", "Anthropic rate limit hit", 503);
  if (err instanceof Anthropic.BadRequestError) return new AppError("llm_bad_request", err.message, 502);
  if (err instanceof Anthropic.APIConnectionError) return new AppError("llm_connection", "Could not reach Anthropic API", 503);
  if (err instanceof Anthropic.APIError) return new AppError("llm_api_error", `${err.status}: ${err.message}`, 502);
  return err instanceof Error ? err : new Error(String(err));
}
