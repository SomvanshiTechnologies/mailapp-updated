import type {
  EvidenceItem,
  LeadStatus,
  Persona,
  QualificationOutcome,
  QualificationOutput,
  QualificationResult,
  ServiceRecommendation,
} from "@mailapp/shared";
import type { ServiceRow } from "../../db/schema.js";

export interface FinaliseOptions {
  persona: Persona;
  /** The campaign's active services: the only valid recommendations. */
  services: Pick<ServiceRow, "id" | "name">[];
  /** A qualified lead whose service fits worse than this goes to human review. */
  minFitScore: number;
  model: string | null;
  now?: Date;
}

/** The lead status each qualification outcome puts the lead in. */
export function leadStatusForOutcome(outcome: QualificationOutcome): LeadStatus {
  switch (outcome) {
    case "qualified":
      return "qualified";
    case "unqualified":
      return "unqualified";
    case "needs_research":
    case "human_review":
      return "on_hold";
  }
}

function verifiedEvidence(persona: Persona): EvidenceItem[] {
  return (persona.evidence ?? []).filter((e) => e.basis === "verified");
}

/**
 * Decide without calling the model when the research cannot support a decision: there is no
 * verified evidence at all, so any "qualified" answer would rest on assumptions. Returns null
 * when the model should be asked.
 */
export function preQualify(persona: Persona | null, opts: { now?: Date } = {}): QualificationResult | null {
  if (persona && verifiedEvidence(persona).length > 0) return null;
  return {
    outcome: "needs_research",
    confidence: "low",
    summary: persona
      ? "The research found no verified facts about this company, so it cannot be qualified yet."
      : "This lead has no research to qualify on.",
    criteria: [],
    service: null,
    noServiceReason: "Not assessed: research is insufficient.",
    adjustments: ["Decided by rule: no verified evidence, so the model was not asked."],
    modelOutcome: null,
    decidedBy: "rules",
    decidedAt: (opts.now ?? new Date()).toISOString(),
    decidedByUser: null,
    model: null,
  };
}

/**
 * Check the model's answer against the real catalogue and the evidence, and apply the rules
 * that keep unsupported decisions from going out automatically:
 *
 * - evidence numbers that do not exist are dropped;
 * - a service id not in the catalogue is matched by exact name, otherwise discarded;
 * - "qualified" becomes "human_review" when no service fits, when the service is not backed by
 *   at least one verified evidence item, or when its fit score is below the minimum;
 * - unqualified and needs_research leads carry no service.
 */
export function finaliseQualification(output: QualificationOutput, opts: FinaliseOptions): QualificationResult {
  const evidence = opts.persona.evidence ?? [];
  const adjustments: string[] = [];
  let droppedRefs = 0;
  const resolve = (refs: number[]): EvidenceItem[] =>
    [...new Set(refs)].flatMap((n) => {
      const item = Number.isInteger(n) ? evidence[n - 1] : undefined;
      if (!item) {
        droppedRefs++;
        return [];
      }
      return [item];
    });

  const criteria = output.criteria.map((c) => ({ criterion: c.criterion, assessment: c.assessment, evidence: resolve(c.evidenceRefs), note: c.note }));

  let service: ServiceRecommendation | null = null;
  let noServiceReason = output.noServiceReason;
  const m = output.serviceMatch;
  if (m.serviceId || m.serviceName) {
    const byId = opts.services.find((s) => s.id === m.serviceId);
    const byName = byId ? undefined : opts.services.find((s) => s.name.trim().toLowerCase() === m.serviceName.trim().toLowerCase());
    const match = byId ?? byName;
    if (match) {
      if (byName) adjustments.push(`The model gave an unknown service id; matched "${match.name}" by name.`);
      service = {
        serviceId: match.id,
        serviceName: match.name,
        fitScore: Math.max(0, Math.min(10, m.fitScore)),
        rationale: m.rationale,
        supportingEvidence: resolve(m.evidenceRefs),
      };
    } else {
      adjustments.push(`The model recommended "${m.serviceName || m.serviceId}", which is not in this campaign's service catalogue; no service is recommended.`);
      noServiceReason ||= "The suggested service is not in the catalogue.";
    }
  }
  if (droppedRefs > 0) adjustments.push(`Ignored ${droppedRefs} citation(s) to evidence that does not exist.`);

  let outcome = output.outcome;
  if (outcome === "qualified") {
    if (verifiedEvidence(opts.persona).length === 0) {
      outcome = "needs_research";
      adjustments.push("Changed qualified → needs research: there is no verified evidence.");
    } else if (!service) {
      outcome = "human_review";
      adjustments.push("Changed qualified → human review: no suitable service was identified.");
    } else if (!service.supportingEvidence.some((e) => e.basis === "verified")) {
      outcome = "human_review";
      adjustments.push("Changed qualified → human review: the recommended service is not supported by any verified evidence.");
    } else if (service.fitScore < opts.minFitScore) {
      outcome = "human_review";
      adjustments.push(`Changed qualified → human review: service fit ${service.fitScore}/10 is below the minimum of ${opts.minFitScore}.`);
    }
  }
  if (outcome === "unqualified" || outcome === "needs_research") service = null;
  if (!service && !noServiceReason) noServiceReason = "No service was recommended.";
  if (service) noServiceReason = "";

  return {
    outcome,
    confidence: output.confidence,
    summary: output.summary,
    criteria,
    service,
    noServiceReason,
    adjustments,
    modelOutcome: output.outcome,
    decidedBy: adjustments.some((a) => a.startsWith("Changed")) ? "rules" : "ai",
    decidedAt: (opts.now ?? new Date()).toISOString(),
    decidedByUser: null,
    model: opts.model,
  };
}

/** A decision made (or overridden) by an operator in the dashboard. */
export function humanQualification(
  previous: QualificationResult | null,
  decision: { outcome: "qualified" | "unqualified"; service: ServiceRecommendation | null; note: string; userEmail: string; now?: Date },
): QualificationResult {
  const by = `Set to ${decision.outcome.replace("_", " ")} by ${decision.userEmail}${decision.note ? `: ${decision.note}` : "."}`;
  return {
    outcome: decision.outcome,
    confidence: previous?.confidence ?? "low",
    summary: previous?.summary ?? "",
    criteria: previous?.criteria ?? [],
    service: decision.outcome === "qualified" ? decision.service : null,
    noServiceReason: decision.outcome === "qualified" && decision.service ? "" : previous?.noServiceReason || "No service was recommended.",
    adjustments: [...(previous?.adjustments ?? []), by],
    modelOutcome: previous?.modelOutcome ?? null,
    decidedBy: "human",
    decidedAt: (decision.now ?? new Date()).toISOString(),
    decidedByUser: decision.userEmail,
    model: previous?.model ?? null,
  };
}
