import OpenAI from "openai";
import { zodResponseFormat, zodTextFormat } from "openai/helpers/zod";
import { DraftOutputSchema, PersonaSchema, ZERO_USAGE, type DraftOutput, type Persona } from "@mailapp/shared";
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

/**
 * Which API surface to speak.
 * "responses" is OpenAI's own Responses API: hosted web search, reasoning effort, and a
 * batch endpoint. "chat" is the Chat Completions shape that OpenAI-compatible providers
 * (DeepSeek) implement — no hosted search, no batch endpoint.
 */
export type OpenAiDialect = "responses" | "chat";

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

function responsesUsage(u: ResponsesUsage | null | undefined): LlmUsage {
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  // OpenAI reports cached tokens inside input_tokens, so split them out to price correctly.
  return {
    inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cached),
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

function chatUsage(u: OpenAI.CompletionUsage | null | undefined): LlmUsage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** Pull the first JSON object out of a response, tolerating a fenced code block. */
function parseJson<T>(text: string, what: string): T {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new AppError("llm_parse", `${what} output was not valid JSON`, 502);
  }
}

/**
 * OpenAI-compatible adapter. Research is a single grounded call (the hosted web_search tool
 * does its own iteration server-side, so no client loop is needed) followed by a structured
 * persona call; drafting is one structured call.
 */
export class OpenAiAdapter implements LlmAdapter {
  private readonly gate: ConcurrencyGate;

  constructor(
    readonly provider: "openai" | "deepseek",
    private readonly deps: LlmDeps,
    private readonly client: OpenAI,
    private readonly dialect: OpenAiDialect,
  ) {
    this.gate = new ConcurrencyGate(deps.config.LLM_MAX_CONCURRENCY);
  }

  static create(provider: "openai" | "deepseek", deps: LlmDeps, apiKey: string, baseUrl: string | null): OpenAiAdapter {
    const client = new OpenAI({ apiKey, baseURL: baseUrl ?? undefined, maxRetries: 3, timeout: 10 * 60_000 });
    return new OpenAiAdapter(provider, deps, client, provider === "openai" ? "responses" : "chat");
  }

  async ping(): Promise<void> {
    await this.client.models.list();
  }

  // ----- request bodies -----

  private researchTools(input: ResearchInput): Array<Record<string, unknown>> | undefined {
    if (this.dialect !== "responses") return undefined;
    if (!input.webSearch || !input.model.supportsWebSearch || input.profile.maxSearches === 0) return undefined;
    // search_context_size is the Responses API's depth dial; map it from the research mode.
    const size = input.profile.maxSearches >= 8 ? "high" : input.profile.maxSearches >= 4 ? "medium" : "low";
    return [{ type: "web_search", search_context_size: size }];
  }

  researchBody(input: ResearchInput, opts: { structured: boolean }): Record<string, unknown> {
    const instructions = researchSystem(input.researchMode);
    const prompt = researchUserMessage(input);
    const maxTokens = Math.min(input.profile.maxOutputTokens, input.model.maxOutput);
    if (this.dialect === "responses") {
      const tools = this.researchTools(input);
      return {
        model: input.model.model,
        instructions,
        input: prompt,
        max_output_tokens: maxTokens,
        ...(input.model.supportsEffort ? { reasoning: { effort: input.profile.effort } } : {}),
        ...(tools ? { tools } : {}),
        // A batched research call must come back as the persona directly: batch requests
        // cannot run a second round trip to structure free-text findings.
        ...(opts.structured ? { text: { format: zodTextFormat(PersonaSchema, "persona") } } : {}),
      };
    }
    return {
      model: input.model.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: prompt },
      ],
      ...(opts.structured ? { response_format: zodResponseFormat(PersonaSchema, "persona") } : {}),
    };
  }

  personaBody(model: ResolvedModel, findings: string, label: string): Record<string, unknown> {
    const prompt = `Research findings for ${label}:\n\n${findings}\n\nConvert these findings into the persona JSON.`;
    if (this.dialect === "responses") {
      return {
        model: model.model,
        instructions: PERSONA_STRUCTURE_SYSTEM,
        input: prompt,
        max_output_tokens: Math.min(8000, model.maxOutput),
        ...(model.supportsEffort ? { reasoning: { effort: "low" } } : {}),
        text: { format: zodTextFormat(PersonaSchema, "persona") },
      };
    }
    return {
      model: model.model,
      max_tokens: Math.min(8000, model.maxOutput),
      messages: [
        { role: "system", content: PERSONA_STRUCTURE_SYSTEM },
        { role: "user", content: prompt },
      ],
      response_format: zodResponseFormat(PersonaSchema, "persona"),
    };
  }

  draftBody(input: DraftInput): Record<string, unknown> {
    // Neither surface has an explicit cache breakpoint: both cache long stable prefixes
    // automatically, so the instruction blocks simply go first and stay byte-identical.
    const instructions = draftSystemBlocks(input.instructions, input.services, input.hardRules).join("\n\n");
    const prompt = draftUserMessage(input);
    const maxTokens = Math.min(8000, input.model.maxOutput);
    if (this.dialect === "responses") {
      return {
        model: input.model.model,
        instructions,
        input: prompt,
        max_output_tokens: maxTokens,
        text: { format: zodTextFormat(DraftOutputSchema, "draft") },
      };
    }
    return {
      model: input.model.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: prompt },
      ],
      response_format: zodResponseFormat(DraftOutputSchema, "draft"),
    };
  }

  prepareResearch(input: ResearchInput): PreparedRequest {
    return { purpose: "research", model: input.model, body: this.researchBody(input, { structured: true }) };
  }

  prepareDraft(input: DraftInput): PreparedRequest {
    return { purpose: "draft", model: input.model, body: this.draftBody(input) };
  }

  // ----- synchronous calls -----

  private async call(body: Record<string, unknown>): Promise<{ text: string; usage: LlmUsage; stopReason: string | null }> {
    if (this.dialect === "responses") {
      const res = (await this.client.responses.create(body as never)) as unknown as {
        output_text?: string;
        status?: string;
        incomplete_details?: { reason?: string };
        usage?: ResponsesUsage;
      };
      return {
        text: res.output_text ?? "",
        usage: responsesUsage(res.usage),
        stopReason: res.incomplete_details?.reason ?? res.status ?? null,
      };
    }
    const res = await this.client.chat.completions.create(body as never);
    const choice = res.choices?.[0];
    return { text: choice?.message?.content ?? "", usage: chatUsage(res.usage), stopReason: choice?.finish_reason ?? null };
  }

  async research(input: ResearchInput): Promise<LlmResult<Persona>> {
    const release = await this.gate.acquire();
    const started = Date.now();
    let usage: LlmUsage = ZERO_USAGE;
    const ids = { leadId: input.lead.id, campaignId: input.lead.campaignId };
    try {
      const findingsRes = await this.call(this.researchBody(input, { structured: false }));
      usage = findingsRes.usage;
      if (!findingsRes.text.trim()) throw new AppError("llm_empty", "Research produced no findings", 502);

      const personaRes = await this.call(this.personaBody(input.model, findingsRes.text, input.lead.company ?? input.lead.email));
      usage = {
        inputTokens: usage.inputTokens + personaRes.usage.inputTokens,
        outputTokens: usage.outputTokens + personaRes.usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens + personaRes.usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens + personaRes.usage.cacheWriteTokens,
      };
      const persona = PersonaSchema.parse(parseJson<unknown>(personaRes.text, "Persona"));

      const durationMs = Date.now() - started;
      const cost = await recordLlmCall(this.deps, {
        purpose: "research",
        model: input.model,
        usage,
        durationMs,
        stopReason: findingsRes.stopReason,
        ok: true,
        error: null,
        ...ids,
      });
      return {
        output: persona,
        model: input.model.model,
        usage,
        durationMs,
        stopReason: findingsRes.stopReason,
        notes: findingsRes.text,
        costMicroUsd: cost,
      };
    } catch (err) {
      const durationMs = Date.now() - started;
      await recordLlmCall(this.deps, {
        purpose: "research",
        model: input.model,
        usage,
        durationMs,
        stopReason: null,
        ok: false,
        error: describeOpenAiError(err),
        ...ids,
      });
      throw normaliseOpenAiError(this.provider, err);
    } finally {
      release();
    }
  }

  async draft(input: DraftInput): Promise<LlmResult<DraftOutput>> {
    const release = await this.gate.acquire();
    const started = Date.now();
    let usage: LlmUsage = ZERO_USAGE;
    const ids = { leadId: input.lead.id, campaignId: input.lead.campaignId };
    try {
      const res = await this.call(this.draftBody(input));
      usage = res.usage;
      const out = DraftOutputSchema.parse(parseJson<unknown>(res.text, "Draft"));
      const durationMs = Date.now() - started;
      const cost = await recordLlmCall(this.deps, {
        purpose: "draft",
        model: input.model,
        usage,
        durationMs,
        stopReason: res.stopReason,
        ok: true,
        error: null,
        ...ids,
      });
      return { output: out, model: input.model.model, usage, durationMs, stopReason: res.stopReason, costMicroUsd: cost };
    } catch (err) {
      const durationMs = Date.now() - started;
      await recordLlmCall(this.deps, {
        purpose: "draft",
        model: input.model,
        usage,
        durationMs,
        stopReason: null,
        ok: false,
        error: describeOpenAiError(err),
        ...ids,
      });
      throw normaliseOpenAiError(this.provider, err);
    } finally {
      release();
    }
  }

  /** The batch layer needs the raw client to upload the JSONL file and poll the job. */
  get raw(): OpenAI {
    return this.client;
  }

  get surface(): OpenAiDialect {
    return this.dialect;
  }
}

export function describeOpenAiError(err: unknown): string {
  if (err instanceof OpenAI.APIError) return `${err.name} ${err.status ?? "?"}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function normaliseOpenAiError(provider: string, err: unknown): Error {
  if (err instanceof AppError) return err;
  if (err instanceof OpenAI.AuthenticationError) return new AppError("llm_auth", `${provider} API key rejected`, 502);
  if (err instanceof OpenAI.RateLimitError) return new AppError("llm_rate_limited", `${provider} rate limit hit`, 503);
  if (err instanceof OpenAI.BadRequestError) return new AppError("llm_bad_request", err.message, 502);
  if (err instanceof OpenAI.APIConnectionError) return new AppError("llm_connection", `Could not reach ${provider}`, 503);
  if (err instanceof OpenAI.APIError) return new AppError("llm_api_error", `${err.status ?? "?"}: ${err.message}`, 502);
  return err instanceof Error ? err : new Error(String(err));
}

export { responsesUsage, chatUsage, parseJson as parseOpenAiJson };
