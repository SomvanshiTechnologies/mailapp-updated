import { GoogleGenAI, type GenerateContentConfig, type GenerateContentResponse } from "@google/genai";
import { z } from "zod/v4";
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
import { parseOpenAiJson as parseJson } from "./openai.js";
import { recordLlmCall } from "./usage.js";

/**
 * Gemini's responseSchema is an OpenAPI subset: no $ref, no additionalProperties, and
 * property order must be given explicitly. z.toJSONSchema with inlined refs gets us most of
 * the way; this strips what Gemini rejects.
 */
function geminiSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "output", target: "draft-7" }) as Record<string, unknown>;
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === "additionalProperties" || k === "$schema" || k === "default" || k === "examples") continue;
      out[k] = clean(v);
    }
    // Gemini honours propertyOrdering, which keeps generated JSON stable across calls.
    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      out.propertyOrdering = Object.keys(out.properties as Record<string, unknown>);
    }
    return out;
  };
  return clean(json) as Record<string, unknown>;
}

const PERSONA_GEMINI_SCHEMA = geminiSchema(PersonaSchema);
const DRAFT_GEMINI_SCHEMA = geminiSchema(DraftOutputSchema);

function usageOf(res: GenerateContentResponse): LlmUsage {
  const u = res.usageMetadata;
  const cached = u?.cachedContentTokenCount ?? 0;
  // promptTokenCount includes cached content, so subtract it to price the two rates apart.
  return {
    inputTokens: Math.max(0, (u?.promptTokenCount ?? 0) - cached) + (u?.toolUsePromptTokenCount ?? 0),
    // Thought tokens are billed as output on Gemini.
    outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

function textOf(res: GenerateContentResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n");
}

/**
 * Gemini adapter. Research grounds on Google Search when the model supports it; grounding
 * and a response schema cannot be combined, so research runs ungrounded-structured in two
 * phases exactly like the other providers.
 */
export class GeminiAdapter implements LlmAdapter {
  readonly provider = "gemini" as const;
  private readonly gate: ConcurrencyGate;

  constructor(
    private readonly deps: LlmDeps,
    private readonly client: GoogleGenAI,
  ) {
    this.gate = new ConcurrencyGate(deps.config.LLM_MAX_CONCURRENCY);
  }

  static create(deps: LlmDeps, apiKey: string): GeminiAdapter {
    return new GeminiAdapter(deps, new GoogleGenAI({ apiKey }));
  }

  async ping(): Promise<void> {
    // Cheapest authenticated call available on the Developer API.
    await this.client.models.list({ config: { pageSize: 1 } });
  }

  // ----- request bodies -----

  researchConfig(input: ResearchInput, opts: { structured: boolean }): GenerateContentConfig {
    const grounded = input.webSearch && input.model.supportsWebSearch && input.profile.maxSearches > 0 && !opts.structured;
    return {
      systemInstruction: researchSystem(input.researchMode),
      maxOutputTokens: Math.min(input.profile.maxOutputTokens, input.model.maxOutput),
      ...(grounded ? { tools: [{ googleSearch: {} }] } : {}),
      ...(opts.structured ? { responseMimeType: "application/json", responseJsonSchema: PERSONA_GEMINI_SCHEMA } : {}),
    };
  }

  personaConfig(model: ResolvedModel): GenerateContentConfig {
    return {
      systemInstruction: PERSONA_STRUCTURE_SYSTEM,
      maxOutputTokens: Math.min(8000, model.maxOutput),
      responseMimeType: "application/json",
      responseJsonSchema: PERSONA_GEMINI_SCHEMA,
    };
  }

  draftConfig(input: DraftInput): GenerateContentConfig {
    return {
      systemInstruction: draftSystemBlocks(input.instructions, input.services, input.hardRules).join("\n\n"),
      maxOutputTokens: Math.min(8000, input.model.maxOutput),
      responseMimeType: "application/json",
      responseJsonSchema: DRAFT_GEMINI_SCHEMA,
    };
  }

  prepareResearch(input: ResearchInput): PreparedRequest {
    return {
      purpose: "research",
      model: input.model,
      body: {
        model: input.model.model,
        contents: researchUserMessage(input),
        config: this.researchConfig(input, { structured: true }) as unknown as Record<string, unknown>,
      },
    };
  }

  prepareDraft(input: DraftInput): PreparedRequest {
    return {
      purpose: "draft",
      model: input.model,
      body: {
        model: input.model.model,
        contents: draftUserMessage(input),
        config: this.draftConfig(input) as unknown as Record<string, unknown>,
      },
    };
  }

  // ----- synchronous calls -----

  async research(input: ResearchInput): Promise<LlmResult<Persona>> {
    const release = await this.gate.acquire();
    const started = Date.now();
    let usage: LlmUsage = ZERO_USAGE;
    const ids = { leadId: input.lead.id, campaignId: input.lead.campaignId };
    try {
      const findingsRes = await this.client.models.generateContent({
        model: input.model.model,
        contents: researchUserMessage(input),
        config: this.researchConfig(input, { structured: false }),
      });
      usage = usageOf(findingsRes);
      const findings = textOf(findingsRes);
      if (!findings.trim()) throw new AppError("llm_empty", "Research produced no findings", 502);

      const personaRes = await this.client.models.generateContent({
        model: input.model.model,
        contents: `Research findings for ${input.lead.company ?? input.lead.email}:\n\n${findings}\n\nConvert these findings into the persona JSON.`,
        config: this.personaConfig(input.model),
      });
      const pu = usageOf(personaRes);
      usage = {
        inputTokens: usage.inputTokens + pu.inputTokens,
        outputTokens: usage.outputTokens + pu.outputTokens,
        cacheReadTokens: usage.cacheReadTokens + pu.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens + pu.cacheWriteTokens,
      };
      const persona = PersonaSchema.parse(parseJson<unknown>(textOf(personaRes), "Persona"));

      const durationMs = Date.now() - started;
      const cost = await recordLlmCall(this.deps, {
        purpose: "research",
        model: input.model,
        usage,
        durationMs,
        stopReason: findingsRes.candidates?.[0]?.finishReason ?? null,
        ok: true,
        error: null,
        ...ids,
      });
      return { output: persona, model: input.model.model, usage, durationMs, stopReason: null, notes: findings, costMicroUsd: cost };
    } catch (err) {
      const durationMs = Date.now() - started;
      await recordLlmCall(this.deps, {
        purpose: "research",
        model: input.model,
        usage,
        durationMs,
        stopReason: null,
        ok: false,
        error: describeGeminiError(err),
        ...ids,
      });
      throw normaliseGeminiError(err);
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
      const res = await this.client.models.generateContent({
        model: input.model.model,
        contents: draftUserMessage(input),
        config: this.draftConfig(input),
      });
      usage = usageOf(res);
      const out = DraftOutputSchema.parse(parseJson<unknown>(textOf(res), "Draft"));
      const durationMs = Date.now() - started;
      const cost = await recordLlmCall(this.deps, {
        purpose: "draft",
        model: input.model,
        usage,
        durationMs,
        stopReason: res.candidates?.[0]?.finishReason ?? null,
        ok: true,
        error: null,
        ...ids,
      });
      return { output: out, model: input.model.model, usage, durationMs, stopReason: null, costMicroUsd: cost };
    } catch (err) {
      const durationMs = Date.now() - started;
      await recordLlmCall(this.deps, {
        purpose: "draft",
        model: input.model,
        usage,
        durationMs,
        stopReason: null,
        ok: false,
        error: describeGeminiError(err),
        ...ids,
      });
      throw normaliseGeminiError(err);
    } finally {
      release();
    }
  }

  get raw(): GoogleGenAI {
    return this.client;
  }
}

export function describeGeminiError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function normaliseGeminiError(err: unknown): Error {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // The SDK surfaces HTTP failures as plain Errors carrying the status in the message.
  if (/\b401\b|\b403\b|API key not valid/i.test(message)) return new AppError("llm_auth", "Gemini API key rejected", 502);
  if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(message)) return new AppError("llm_rate_limited", "Gemini rate limit or quota hit", 503);
  if (/\b400\b|INVALID_ARGUMENT/i.test(message)) return new AppError("llm_bad_request", message, 502);
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(message)) return new AppError("llm_connection", "Could not reach Gemini", 503);
  return err instanceof Error ? err : new Error(message);
}

export { usageOf as geminiUsageOf, textOf as geminiTextOf, geminiSchema };
