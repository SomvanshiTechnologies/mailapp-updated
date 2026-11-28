import type { DraftOutput, Persona, QualificationOutput } from "@mailapp/shared";
import type { DraftInput, LlmAdapter, LlmDeps, LlmResult, PreparedRequest, QualifyInput, ResearchInput } from "./provider.js";
import { recordLlmCall } from "./usage.js";

const RESEARCH_USAGE = { inputTokens: 1200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };
const QUALIFY_USAGE = { inputTokens: 900, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * Deterministic qualification. Qualified with the first catalogue service when there is
 * verified evidence; needs_research when there is none. Lead-note flags force other answers:
 * mock:unqualified, mock:human-review, mock:no-service, mock:bad-service (an id not in the
 * catalogue), mock:unsupported-service (cites only inferred evidence), mock:low-fit,
 * mock:fail-qualify.
 */
export function mockQualification(input: QualifyInput, flag: (f: string) => boolean): QualificationOutput {
  const evidence = input.persona.evidence ?? [];
  const verifiedRefs = evidence.flatMap((e, i) => (e.basis === "verified" ? [i + 1] : []));
  const inferredRefs = evidence.flatMap((e, i) => (e.basis === "verified" ? [] : [i + 1]));
  const service = input.services[0];
  let outcome: QualificationOutput["outcome"] = verifiedRefs.length ? "qualified" : "needs_research";
  if (flag("unqualified")) outcome = "unqualified";
  if (flag("human-review")) outcome = "human_review";
  const noService = !service || flag("no-service") || outcome === "unqualified";
  const refs = flag("unsupported-service") ? inferredRefs : verifiedRefs;
  return {
    outcome,
    confidence: verifiedRefs.length >= 2 ? "medium" : "low",
    summary: `Mock qualification for ${input.lead.company ?? input.lead.email}: ${outcome}.`,
    criteria: [
      { criterion: "Company is identifiable from verified sources", assessment: verifiedRefs.length ? "met" : "unknown", evidenceRefs: verifiedRefs.slice(0, 2), note: "" },
      { criterion: "Industry matches targeting", assessment: outcome === "unqualified" ? "not_met" : "met", evidenceRefs: [], note: input.lead.industry ?? "" },
    ],
    serviceMatch: noService
      ? { serviceId: "", serviceName: "", fitScore: 0, rationale: "", evidenceRefs: [] }
      : {
          serviceId: flag("bad-service") ? "00000000-0000-0000-0000-000000000000" : service.id,
          serviceName: flag("bad-service") ? "Made Up Service" : service.name,
          fitScore: flag("low-fit") ? 2 : 8,
          rationale: `${service.name} addresses the needs suggested by the evidence.`,
          evidenceRefs: refs,
        },
    noServiceReason: noService ? (service ? "No service fits this lead." : "The campaign has no services.") : "",
  };
}
const DRAFT_USAGE = { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 1000, cacheWriteTokens: 0 };

/**
 * Deterministic provider for tests, CI and dry-runs. Produces plausible output from the lead
 * record alone; never calls the network. Behaviour can be tweaked per lead through the `notes`
 * column: "mock:fail-research", "mock:fail-draft", "mock:long-draft", "mock:banned".
 *
 * Mock rates are zero, so recorded calls carry tokens but no cost.
 */
export class MockLlmAdapter implements LlmAdapter {
  readonly provider = "mock" as const;
  constructor(private readonly deps: LlmDeps) {}

  private flag(input: { lead: { notes: string | null } }, f: string): boolean {
    return (input.lead.notes ?? "").includes(`mock:${f}`);
  }

  async qualify(input: QualifyInput): Promise<LlmResult<QualificationOutput>> {
    const ids = { leadId: input.lead.id, campaignId: input.lead.campaignId };
    const failed = this.flag(input, "fail-qualify");
    await recordLlmCall(this.deps, {
      purpose: "qualify",
      model: input.model,
      usage: QUALIFY_USAGE,
      durationMs: 5,
      stopReason: failed ? null : "end_turn",
      ok: !failed,
      error: failed ? "mock failure" : null,
      ...ids,
    });
    if (failed) throw new Error("mock qualification failure");
    return { output: mockQualification(input, (f) => this.flag(input, f)), model: input.model.model, usage: QUALIFY_USAGE, durationMs: 5, stopReason: "end_turn", costMicroUsd: 0 };
  }

  async research(input: ResearchInput): Promise<LlmResult<Persona>> {
    const ids = { leadId: input.lead.id, campaignId: input.lead.campaignId };
    if (this.flag(input, "fail-research")) {
      await recordLlmCall(this.deps, {
        purpose: "research",
        model: input.model,
        usage: RESEARCH_USAGE,
        durationMs: 5,
        stopReason: null,
        ok: false,
        error: "mock failure",
        ...ids,
      });
      throw new Error("mock research failure");
    }
    const persona = mockPersona(input);
    const cost = await recordLlmCall(this.deps, {
      purpose: "research",
      model: input.model,
      usage: RESEARCH_USAGE,
      durationMs: 5,
      stopReason: "end_turn",
      ok: true,
      error: null,
      ...ids,
    });
    return {
      output: persona,
      model: input.model.model,
      usage: RESEARCH_USAGE,
      durationMs: 5,
      stopReason: "end_turn",
      notes: "mock findings",
      costMicroUsd: cost,
    };
  }

  async draft(input: DraftInput): Promise<LlmResult<DraftOutput>> {
    const ids = { leadId: input.lead.id, campaignId: input.lead.campaignId };
    if (this.flag(input, "fail-draft")) {
      await recordLlmCall(this.deps, {
        purpose: "draft",
        model: input.model,
        usage: DRAFT_USAGE,
        durationMs: 5,
        stopReason: null,
        ok: false,
        error: "mock failure",
        ...ids,
      });
      throw new Error("mock draft failure");
    }
    const out = mockDraft(input, {
      long: this.flag(input, "long-draft") && !input.regenerationFeedback,
      banned: this.flag(input, "banned") && !input.regenerationFeedback,
    });
    const cost = await recordLlmCall(this.deps, {
      purpose: "draft",
      model: input.model,
      usage: DRAFT_USAGE,
      durationMs: 5,
      stopReason: "end_turn",
      ok: true,
      error: null,
      ...ids,
    });
    return { output: out, model: input.model.model, usage: DRAFT_USAGE, durationMs: 5, stopReason: "end_turn", costMicroUsd: cost };
  }

  /**
   * The mock provider has no batch endpoint, so a "batch" selection on it still produces a
   * request body; the batch runner executes mock items inline on the next tick, which keeps
   * the batch state machine testable without a network.
   */
  prepareResearch(input: ResearchInput): PreparedRequest {
    return { purpose: "research", model: input.model, body: { kind: "mock-research", leadId: input.lead.id } };
  }

  prepareDraft(input: DraftInput): PreparedRequest {
    return { purpose: "draft", model: input.model, body: { kind: "mock-draft", leadId: input.lead.id, step: input.step.step } };
  }
}

/**
 * Evidence the mock "finds": verified claims citing the fetched website, inferred ones otherwise.
 * Lead note "mock:unsourced-claim" adds a claim wrongly marked verified with no URL, to exercise
 * the downgrade rule.
 */
function mockEvidence(input: ResearchInput, company: string, role: string): Persona["evidence"] {
  const w = input.website;
  const items: Persona["evidence"] = w
    ? [
        { claim: `${company} describes itself as: ${w.description || w.title}`, category: "company", basis: "verified", sourceUrl: w.url, excerpt: (w.description || w.title).slice(0, 200) },
        ...w.headings.slice(0, 2).map((h) => ({ claim: `Offers ${h}`, category: "offering" as const, basis: "verified" as const, sourceUrl: w.url, excerpt: h })),
      ]
    : [];
  items.push({ claim: `As ${role}, the contact likely cares about efficiency`, category: "person", basis: "inferred", sourceUrl: "", excerpt: "" });
  if ((input.lead.notes ?? "").includes("mock:unsourced-claim")) {
    items.push({ claim: `${company} recently raised funding`, category: "signal", basis: "verified", sourceUrl: "", excerpt: "" });
  }
  return items;
}

export function mockPersona(input: ResearchInput): Persona {
  const company = input.lead.company ?? input.lead.email.split("@")[1];
  const role = input.lead.jobTitle ?? "decision maker";
  return {
    companySummary: `${company} is a ${input.lead.industry ?? "technology"} company${
      input.website?.description ? `: ${input.website.description}` : ""
    }.`,
    companyOffering: input.website?.headings.slice(0, 3) ?? ["core product"],
    industry: input.lead.industry ?? "unknown",
    companySizeSignal: "unknown (mock)",
    personRoleSummary: `${role} at ${company}, likely responsible for outcomes in their function.`,
    likelyPriorities: ["growth", "efficiency", "reliability"],
    painPoints: ["limited bandwidth", "manual processes", "scaling challenges"],
    recentSignals: [],
    personalisationHooks: [`${company} website`, `${role} role`],
    sources: input.website ? [input.website.url] : [],
    evidence: mockEvidence(input, company, role),
    opportunities: [
      {
        opportunity: `Help ${company} reduce manual work`,
        rationale: "Inferred from the role and typical needs of similar companies.",
        relatedService: input.serviceSummaries[0]?.split(":")[0] ?? "",
      },
    ],
    confidence: input.website ? "medium" : "low",
    notes: "Generated by mock provider.",
  };
}

export function mockDraft(input: DraftInput, opts: { long?: boolean; banned?: boolean } = {}): DraftOutput {
  const first = input.lead.firstName ?? "there";
  const company = input.lead.company ?? "your team";
  const service = input.services[0];
  const serviceName = service?.name ?? "our services";
  const isFollowUp = input.step.step > 1;
  let body: string;
  if (isFollowUp) {
    body = `Hi ${first},\n\nFollowing up on my note about ${serviceName}. ${input.persona.painPoints[0] ? `Teams like ${company} often mention ${input.persona.painPoints[0]}, and that is exactly where we help.` : ""}\n\nWould a short call next week be useful? Happy to share a relevant example beforehand.`;
  } else {
    body = `Hi ${first},\n\nI came across ${company} and noticed ${input.persona.personalisationHooks[0] ?? "your work"}. ${input.persona.painPoints[0] ? `Many ${input.persona.industry} teams tell us that ${input.persona.painPoints[0]} slows them down.` : ""}\n\nWe help with ${serviceName}${service?.valueProps[0] ? `: ${service.valueProps[0]}` : ""}. If useful, I can share a two-minute overview of how a similar team approached it.\n\nWould it make sense to compare notes for fifteen minutes next week?`;
  }
  if (opts.long) body += "\n\n" + "This sentence is padding to exceed the word limit. ".repeat(60);
  if (opts.banned) body += "\n\nThis is a limited time offer, act now.";
  return {
    selectedServices: service
      ? [{ serviceId: service.id, serviceName: service.name, fitScore: 7.5, rationale: "Best fit by description (mock)." }]
      : [],
    pitchAngle: `Connect ${company}'s ${input.persona.painPoints[0] ?? "priorities"} with ${serviceName}.`,
    subject: isFollowUp ? `Re: ${serviceName} for ${company}` : `${serviceName} for ${company}`,
    bodyText: body,
    callToAction: "15-minute call next week",
    personalisationUsed: input.persona.personalisationHooks.slice(0, 1),
    selfCheck: { wordCount: body.split(/\s+/).length, followsTone: true, followsRules: true, concerns: [] },
  };
}
