import type { EvidenceItem, Persona, ResearchIssue, ResearchStatus } from "@mailapp/shared";

/** Fewer verified, sourced findings than this and the research counts as partial. */
export const MIN_VERIFIED_FACTS = 2;

export interface ResearchContext {
  /** A website URL could be derived from the lead (website column or email domain). */
  websiteAttempted: boolean;
  /** The website was actually fetched and extracted. */
  websiteFetched: boolean;
}

export interface ResearchAssessment {
  /** The persona with evidence rules enforced (unsourced claims downgraded, sources merged). */
  persona: Persona;
  status: Exclude<ResearchStatus, "failed">;
  issues: ResearchIssue[];
  verifiedCount: number;
  inferredCount: number;
}

/** True for an absolute http(s) URL. Anything else cannot back a "verified" claim. */
export function isSourceUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * Enforce the evidence rules on a model-produced persona and grade how complete it is.
 *
 * - A claim marked "verified" without a usable source URL is downgraded to "inferred", so an
 *   unsupported assumption is never presented as a verified fact downstream.
 * - Every cited source URL is added to `sources`.
 * - Confidence is capped at "low" when nothing is verified.
 * - The result is "partial" when the website could not be read, nothing is sourced, too few
 *   facts are verified, or the model itself reports low confidence.
 *
 * Pure function: tolerates personas stored before evidence existed (no `evidence` field).
 */
export function assessResearch(input: Persona, ctx: ResearchContext): ResearchAssessment {
  const issues: ResearchIssue[] = [];
  let downgraded = 0;

  const evidence: EvidenceItem[] = (input.evidence ?? []).map((item) => {
    const sourceUrl = isSourceUrl(item.sourceUrl) ? item.sourceUrl.trim() : "";
    if (item.basis === "verified" && !sourceUrl) {
      downgraded += 1;
      return { ...item, basis: "inferred", sourceUrl };
    }
    return { ...item, sourceUrl };
  });

  const sources = dedupe([...(input.sources ?? []).filter(isSourceUrl), ...evidence.map((e) => e.sourceUrl).filter(Boolean)]);
  const verifiedCount = evidence.filter((e) => e.basis === "verified").length;
  const inferredCount = evidence.length - verifiedCount;

  const confidence = verifiedCount === 0 ? "low" : input.confidence;

  if (!ctx.websiteAttempted) issues.push("no_website");
  else if (!ctx.websiteFetched) issues.push("website_unavailable");
  if (sources.length === 0) issues.push("no_sources");
  if (verifiedCount < MIN_VERIFIED_FACTS) issues.push("few_verified_facts");
  if (confidence === "low") issues.push("low_confidence");
  if (downgraded > 0) issues.push("unsourced_claims_downgraded");

  // "no_website" alone is not a reason to call research partial: web search may have covered it.
  // Downgrading is a correction, not a gap, so it does not make research partial either.
  const gaps = issues.filter((i) => i !== "no_website" && i !== "unsourced_claims_downgraded");
  const status = gaps.length > 0 ? "partial" : "complete";

  return {
    persona: { ...input, evidence, opportunities: input.opportunities ?? [], sources, confidence },
    status,
    issues,
    verifiedCount,
    inferredCount,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
