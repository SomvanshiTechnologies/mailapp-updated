// LLM structured-output schemas. These must be zod v4 schemas: the Anthropic SDK's
// zodOutputFormat() converts them with z.toJSONSchema from "zod/v4", which rejects v3 schemas.
import { z } from "zod/v4";

// ---------- Persona / research (LLM structured output) ----------
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
  confidence: z.enum(["low", "medium", "high"]),
  notes: z.string().describe("Caveats, contradictions, or gaps in the research."),
});
export type Persona = z.infer<typeof PersonaSchema>;

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
