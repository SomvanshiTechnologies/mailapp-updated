import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AutoParseableOutputFormat } from "@anthropic-ai/sdk/lib/parser";
import type { ZodType } from "zod/v4";
import { DraftOutputSchema, PersonaSchema, ZERO_USAGE, addUsage, type DraftOutput, type Persona } from "@mailapp/shared";
import { AppError } from "../../lib/errors.js";
import type { ResolvedModel } from "./catalogue.js";
import {
  ConcurrencyGate,
  type DraftInput,
  type LlmAdapter,
  type LlmDeps,
  type LlmResult,
  type LlmUsage,
  type PreparedRequest,
  type ResearchInput,
} from "./provider.js";
import { PERSONA_STRUCTURE_SYSTEM, draftSystemBlocks, draftUserMessage, researchSystem, researchUserMessage } from "./prompts.js";
import { recordLlmCall } from "./usage.js";

function usageOf(msg: { usage: Anthropic.Usage }): LlmUsage {
  return {
    inputTokens: msg.usage.input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
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

/** Server-side research tools, budgeted by the research mode. */
function researchTools(input: ResearchInput): Anthropic.ToolUnion[] | undefined {
  if (!input.webSearch || !input.model.supportsWebSearch || input.profile.maxSearches === 0) return undefined;
  const tools: Anthropic.ToolUnion[] = [{ type: "web_search_20260209", name: "web_search", max_uses: input.profile.maxSearches }];
  if (input.profile.maxFetches > 0) {
    tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: input.profile.maxFetches });
  }
  return tools;
}

/**
 * Claude-backed adapter.
 * Research runs as an agentic loop with server-side web search/fetch, then the findings are
 * converted into a strict Persona JSON with structured outputs. Drafting is a single
 * structured call whose stable prefix (company profile, catalogue, tone/format/rules) is
 * prompt-cached, so every lead after the first in a campaign reads it at cache rates.
 */
export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic" as const;
  private readonly gate: ConcurrencyGate;

  constructor(
    private readonly deps: LlmDeps,
    private readonly client: Anthropic,
  ) {
    this.gate = new ConcurrencyGate(deps.config.LLM_MAX_CONCURRENCY);
  }

  static create(deps: LlmDeps, apiKey: string, baseUrl: string | null): AnthropicAdapter {
    return new AnthropicAdapter(
      deps,
      new Anthropic({ apiKey: apiKey || undefined, baseURL: baseUrl ?? undefined, maxRetries: 3, timeout: 10 * 60_000 }),
    );
  }

  async ping(): Promise<void> {
    await this.client.models.list({ limit: 1 });
  }

  /** The batch layer needs the configured client to create and poll message batches. */
  get raw(): Anthropic {
    return this.client;
  }

  // ----- request bodies, shared by the sync and batch paths -----

  /** The findings pass. Batch submissions use this too, minus the agentic loop. */
  researchBody(input: ResearchInput): Record<string, unknown> {
    return {
      model: input.model.model,
      max_tokens: Math.min(input.profile.maxOutputTokens, input.model.maxOutput),
      system: researchSystem(input.researchMode),
      thinking: { type: "adaptive" as const },
      ...(input.model.supportsEffort ? { output_config: { effort: input.profile.effort } } : {}),
      ...(researchTools(input) ? { tools: researchTools(input) } : {}),
      messages: [{ role: "user" as const, content: researchUserMessage(input) }],
    };
  }

  personaBody(model: ResolvedModel, findings: string, label: string): Record<string, unknown> {
    return {
      model: model.model,
      max_tokens: Math.min(8000, model.maxOutput),
      system: PERSONA_STRUCTURE_SYSTEM,
      ...(model.supportsEffort ? { output_config: { effort: "low" as const } } : {}),
      messages: [
        {
          role: "user" as const,
          content: `Research findings for ${label}:\n\n${findings}\n\nConvert these findings into the persona JSON.`,
        },
      ],
    };
  }

  draftBody(input: DraftInput): Record<string, unknown> {
    const blocks = draftSystemBlocks(input.instructions, input.services, input.hardRules);
    const system: Anthropic.TextBlockParam[] = blocks.map((text, i) => ({
      type: "text",
      text,
      // Cache the whole stable prefix; it is identical for every lead in a campaign.
      ...(i === blocks.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    return {
      model: input.model.model,
      max_tokens: Math.min(8000, input.model.maxOutput),
      system,
      thinking: { type: "adaptive" as const },
      messages: [{ role: "user" as const, content: draftUserMessage(input) }],
    };
  }

  prepareResearch(input: ResearchInput): PreparedRequest {
    // Batch requests cannot run a multi-turn tool loop, so the batched research pass asks for
    // the persona JSON directly and the findings come back as the model's own summary.
    const body = this.researchBody(input);
    return {
      purpose: "research",
      model: input.model,
      body: { ...body, output_config: { ...((body.output_config as object) ?? {}), format: outputFormat(PersonaSchema) } },
    };
  }

  prepareDraft(input: DraftInput): PreparedRequest {
    const body = this.draftBody(input);
    return {
      purpose: "draft",
      model: input.model,
      body: { ...body, output_config: { format: outputFormat(DraftOutputSchema) } },
    };
  }

  // ----- synchronous calls -----

  async research(input: ResearchInput): Promise<LlmResult<Persona>> {
    const release = await this.gate.acquire();
    const started = Date.now();
    let usage: LlmUsage = ZERO_USAGE;
    const ids = { leadId: input.lead.id, campaignId: input.lead.campaignId };
    try {
      // Phase 1: agentic research with server-side tools.
      const base = this.researchBody(input);
      const messages = [...(base.messages as Anthropic.MessageParam[])];
      let findings = "";
      let stopReason: string | null = null;
      for (let i = 0; i < input.profile.maxIterations; i++) {
        const res = await this.client.messages.create({ ...base, messages } as unknown as Anthropic.MessageCreateParamsNonStreaming);
        usage = addUsage(usage, usageOf(res));
        stopReason = res.stop_reason;
        if (res.stop_reason === "refusal") throw new AppError("llm_refusal", "Research request was refused by the model", 502);
        if (res.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: res.content });
          continue;
        }
        findings = textOf(res);
        break;
      }
      if (!findings.trim()) throw new AppError("llm_empty", "Research produced no findings", 502);

      // Phase 2: structure the findings.
      const personaReq = this.personaBody(input.model, findings, input.lead.company ?? input.lead.email);
      const parsed = await this.client.messages.parse({
        ...personaReq,
        output_config: { ...((personaReq.output_config as object) ?? {}), format: outputFormat(PersonaSchema) },
      } as never);
      usage = addUsage(usage, usageOf(parsed));
      if (parsed.stop_reason === "refusal") throw new AppError("llm_refusal", "Persona structuring refused", 502);
      const persona = parsed.parsed_output as Persona | null;
      if (!persona) throw new AppError("llm_parse", "Persona output did not match schema", 502);

      const durationMs = Date.now() - started;
      const cost = await recordLlmCall(this.deps, {
        purpose: "research",
        model: input.model,
        usage,
        durationMs,
        stopReason,
        ok: true,
        error: null,
        ...ids,
      });
      return { output: persona, model: input.model.model, usage, durationMs, stopReason, notes: findings, costMicroUsd: cost };
    } catch (err) {
      const durationMs = Date.now() - started;
      await recordLlmCall(this.deps, {
        purpose: "research",
        model: input.model,
        usage,
        durationMs,
        stopReason: null,
        ok: false,
        error: describeError(err),
        ...ids,
      });
      throw normaliseError(err);
    } finally {
      release();
    }
  }

  async draft(input: DraftInput): Promise<LlmResult<DraftOutput>> {
    const release = await this.gate.acquire();
    const started = Date.now();
    const ids = { leadId: input.lead.id, campaignId: input.lead.campaignId };
    let usage: LlmUsage = ZERO_USAGE;
    try {
      const body = this.draftBody(input);
      const res = await this.client.messages.parse({
        ...body,
        output_config: { format: outputFormat(DraftOutputSchema) },
      } as never);
      usage = usageOf(res);
      if (res.stop_reason === "refusal") throw new AppError("llm_refusal", "Draft request was refused by the model", 502);
      const out = res.parsed_output as DraftOutput | null;
      if (!out) throw new AppError("llm_parse", "Draft output did not match schema", 502);
      const durationMs = Date.now() - started;
      const cost = await recordLlmCall(this.deps, {
        purpose: "draft",
        model: input.model,
        usage,
        durationMs,
        stopReason: res.stop_reason,
        ok: true,
        error: null,
        ...ids,
      });
      return { output: out, model: input.model.model, usage, durationMs, stopReason: res.stop_reason, costMicroUsd: cost };
    } catch (err) {
      const durationMs = Date.now() - started;
      await recordLlmCall(this.deps, {
        purpose: "draft",
        model: input.model,
        usage,
        durationMs,
        stopReason: null,
        ok: false,
        error: describeError(err),
        ...ids,
      });
      throw normaliseError(err);
    } finally {
      release();
    }
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.name} ${err.status}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function normaliseError(err: unknown): Error {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AppError("llm_auth", "Anthropic API key rejected", 502);
  if (err instanceof Anthropic.RateLimitError) return new AppError("llm_rate_limited", "Anthropic rate limit hit", 503);
  if (err instanceof Anthropic.BadRequestError) return new AppError("llm_bad_request", err.message, 502);
  if (err instanceof Anthropic.APIConnectionError) return new AppError("llm_connection", "Could not reach Anthropic API", 503);
  if (err instanceof Anthropic.APIError) return new AppError("llm_api_error", `${err.status}: ${err.message}`, 502);
  return err instanceof Error ? err : new Error(String(err));
}

export { usageOf as anthropicUsageOf };
