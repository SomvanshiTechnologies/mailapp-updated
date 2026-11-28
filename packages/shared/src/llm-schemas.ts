// LLM structured-output schemas. These must be zod v4 schemas: the Anthropic SDK's
// zodOutputFormat() converts them with z.toJSONSchema from "zod/v4", which rejects v3 schemas.
import { z } from "zod/v4";

// ---------- Persona / research (LLM structured output) ----------
export const EVIDENCE_BASES = ["verified", "inferred"] as const;
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

export const EVIDENCE_CATEGORIES = ["company", "offering", "industry", "size", "person", "signal", "other"] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

// Every field is required (empty string when unknown) so the schema stays valid for
// strict structured-output modes, which reject optional properties.
export const EvidenceItemSchema = z.object({
  claim: z.string().describe("One concrete finding, stated plainly."),
  category: z.enum(EVIDENCE_CATEGORIES),
  basis: z
    .enum(EVIDENCE_BASES)
    .describe("verified = directly stated by the cited source; inferred = your reasoning or an assumption."),
  sourceUrl: z.string().describe("URL of the page that states this claim; empty string if there is none."),
  excerpt: z.string().describe("Short quote or close paraphrase from the source supporting the claim; empty string if none."),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const OpportunitySchema = z.object({
  opportunity: z.string().describe("A business opportunity for us with this company."),
  rationale: z.string().describe("Why, referring to the evidence. This is always an inference, not a fact."),
  relatedService: z.string().describe("Name of the most relevant service of ours; empty string if none fits."),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

export const PersonaSchema = z.object({
  companySummary: z.string().describe("2-4 sentences: what the company does, for whom, and how it makes money."),
  companyOffering: z.array(z.string()).describe("Main products or services."),
  industry: z.string(),
  companySizeSignal: z.string().describe("Estimated size/stage with the evidence, e.g. '50-200 employees (LinkedIn)'."),
  personRoleSummary: z.string().describe("What this person likely owns and cares about in their role."),
  likelyPriorities: z.array(z.string()).describe("3-5 likely priorities or goals for this person right now."),
  painPoints: z.array(z.string()).describe("3-5 plausible pain points relevant to our services."),
  recentSignals: z.array(z.string()).describe("Recent news, hiring, launches, funding, or other timely hooks with source."),
  personalisationHooks: z.array(z.string()).describe("Specific, verifiable details usable in an opening line."),
  sources: z.array(z.string()).describe("URLs consulted."),
  evidence: z
    .array(EvidenceItemSchema)
    .describe("The key findings, each labelled verified (with its source) or inferred."),
  opportunities: z.array(OpportunitySchema).describe("1-3 potential business opportunities for us. Always inferences."),
  confidence: z.enum(["low", "medium", "high"]),
  notes: z.string().describe("Caveats, contradictions, or gaps in the research."),
});
export type Persona = z.infer<typeof PersonaSchema>;

/**
 * How complete a lead's research is.
 * complete = enough verified, sourced findings; partial = research ran but is thin
 * (website down, few sources, low confidence); failed = the research call itself failed.
 */
export const RESEARCH_STATUSES = ["complete", "partial", "failed"] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

/** Machine-readable reasons why research is partial. */
export const RESEARCH_ISSUES = [
  "no_website",
  "website_unavailable",
  "no_sources",
  "few_verified_facts",
  "low_confidence",
  "unsourced_claims_downgraded",
] as const;
export type ResearchIssue = (typeof RESEARCH_ISSUES)[number];

export const DraftOutputSchema = z.object({
  selectedServices: z
    .array(
      z.object({
        serviceId: z.string(),
        serviceName: z.string(),
        fitScore: z.number().min(0).max(10),
        rationale: z.string(),
      }),
    )
    .describe("1-2 best-fit services, highest fit first."),
  pitchAngle: z.string().describe("One or two sentences: the core angle connecting their situation to our service."),
  subject: z.string(),
  bodyText: z.string().describe("Plain-text email body. No subject line, no signature placeholders."),
  callToAction: z.string(),
  personalisationUsed: z.array(z.string()).describe("Which hooks from the persona were used."),
  selfCheck: z.object({
    wordCount: z.number(),
    followsTone: z.boolean(),
    followsRules: z.boolean(),
    concerns: z.array(z.string()),
  }),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;
