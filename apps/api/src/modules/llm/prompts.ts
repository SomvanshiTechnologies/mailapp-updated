import type { HardRules, Persona, ResearchMode } from "@mailapp/shared";
import type { LeadRow, ServiceRow } from "../../db/schema.js";
import type { DraftInput, InstructionBundle, QualifyInput, ResearchInput, WebsiteExtract } from "./provider.js";

export function leadBlock(lead: LeadRow): string {
  const lines = [
    `Name: ${[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "(unknown)"}`,
    `Email: ${lead.email}`,
    `Job title: ${lead.jobTitle ?? "(unknown)"}`,
    `Company: ${lead.company ?? "(unknown)"}`,
    `Website: ${lead.website ?? "(unknown)"}`,
    `LinkedIn: ${lead.linkedinUrl ?? "(unknown)"}`,
    `Industry: ${lead.industry ?? "(unknown)"}`,
    `Location: ${lead.location ?? "(unknown)"}`,
    `Notes from the sheet: ${lead.notes ?? "(none)"}`,
  ];
  const extras = Object.entries(lead.extra ?? {}).filter(([, v]) => v && String(v).trim());
  if (extras.length) lines.push(`Other columns: ${extras.map(([k, v]) => `${k}=${v}`).join("; ")}`);
  return lines.join("\n");
}

export function websiteBlock(site: WebsiteExtract | null): string {
  if (!site) return "(website could not be fetched)";
  return [
    `URL: ${site.url}`,
    `Title: ${site.title}`,
    `Meta description: ${site.description}`,
    `Headings: ${site.headings.slice(0, 20).join(" | ")}`,
    `Visible text (truncated):`,
    site.text,
  ].join("\n");
}

export function serviceBlock(s: ServiceRow, includeDetails = true): string {
  const lines = [`Service id: ${s.id}`, `Name: ${s.name}`, `Description: ${s.description}`];
  if (includeDetails) {
    if (s.targetAudience) lines.push(`Target audience: ${s.targetAudience}`);
    if (s.valueProps.length) lines.push(`Value propositions: ${s.valueProps.join("; ")}`);
    if (s.proofPoints.length) lines.push(`Proof points: ${s.proofPoints.join("; ")}`);
    if (s.tags.length) lines.push(`Tags: ${s.tags.join(", ")}`);
  }
  return lines.join("\n");
}

const RESEARCH_SYSTEM_BASE = `You are a B2B sales research analyst. You research a company and a specific person there so that a colleague can write a relevant, honest outreach email.

Ground rules:
- Prefer primary sources (the company website, LinkedIn, press releases, filings, reputable news). Note the URL of each fact.
- Never invent facts. If something is unknown, say so explicitly and lower your confidence.
- Distinguish the company from similarly named companies; use the website domain and location to disambiguate.
- Keep findings concrete: products, customers, pricing model, team size signals, hiring, recent launches, funding, partnerships, tech stack signals, public statements by the person.
- Label every finding VERIFIED or INFERRED. VERIFIED means a page you read states it; give that page's URL and a short quote. INFERRED means it is your reasoning or an assumption (likely priorities, pain points and opportunities are almost always inferred). Never label something verified without a URL.
- Be concise. Bullet points are fine.`;

/**
 * Depth instructions per research mode. The tool budgets are enforced by the adapters; this
 * tells the model how much ground to cover so it does not over-research on a cheap run or
 * stop early on an expensive one.
 */
const RESEARCH_DEPTH: Record<ResearchMode, string> = {
  normal: `Depth: NORMAL. Work mainly from the supplied website extract. Use at most a couple of searches, only to confirm what the company does and who the person is. Do not chase secondary sources. Stop as soon as you can answer the task.`,
  great: `Depth: GREAT. Confirm the company and the person across several independent sources. Look for the current offering, rough size or stage, and anything timely from the last twelve months. Do not go beyond what is needed to write one relevant email.`,
  advance: `Depth: ADVANCE. Dig properly: recent news, funding, hiring patterns, product launches, partnerships, tech-stack signals, and anything the person has published or said publicly. Cross-check contradictory claims and say which source you trust. Note dates on every timely fact.`,
};

export function researchSystem(mode: ResearchMode): string {
  return `${RESEARCH_SYSTEM_BASE}

${RESEARCH_DEPTH[mode]}`;
}

/** Kept for callers that do not vary intensity (and for the existing unit test). */
export const RESEARCH_SYSTEM = researchSystem("great");

export function researchUserMessage(input: ResearchInput): string {
  return `We are researching this lead before outreach.

## Our company (for context on what would be relevant)
${input.companyProfile || "(no company profile provided)"}

## Our services (short list)
${input.serviceSummaries.map((s) => `- ${s}`).join("\n") || "(none)"}

## Lead (from our spreadsheet)
${leadBlock(input.lead)}

## Company website extract (fetched by us)
${websiteBlock(input.website)}

## Task
${
  input.webSearch
    ? `Use web search (and fetch pages when useful) to verify and enrich the above. You may run at most ${input.profile.maxSearches} searches and fetch at most ${input.profile.maxFetches} pages, so choose them deliberately.`
    : "Do not use external tools; work from the material above and general knowledge, and be explicit about uncertainty."
}
Produce research findings covering: what the company does and for whom; its offering; industry; size/stage signals with evidence; what this person's role likely owns; their likely priorities right now; plausible pain points relevant to our services; recent signals (news, hiring, launches, funding) with dates and URLs; specific personalisation hooks that are verifiable; 1-3 business opportunities for us with the reasoning behind each; sources consulted; overall confidence; caveats.
List the key findings as evidence: each with VERIFIED (source URL + short quote) or INFERRED. If the website could not be fetched or little information exists, say so plainly rather than filling gaps with guesses.`;
}

export const PERSONA_STRUCTURE_SYSTEM = `You convert research findings into a structured persona JSON. Copy facts faithfully from the findings; do not add new claims. If a field has no support in the findings, use an empty list or say "unknown".
For "evidence", copy each finding with its label: basis "verified" only when the findings give a source URL for it (put that URL in sourceUrl and the supporting quote in excerpt); otherwise basis "inferred" with empty sourceUrl. Opportunities are always inferences.`;

export const QUALIFY_SYSTEM = `You are a B2B sales qualification analyst. You decide whether a researched lead is worth contacting, and which one of our services (if any) fits them best.

Rules:
- Judge only from the numbered evidence, the research summary and the lead record. Do not use outside knowledge about the company.
- VERIFIED evidence is a sourced fact. INFERRED evidence is an assumption: it can support a decision but never on its own justify "qualified".
- Cite evidence by number (E1, E2, ...) in evidenceRefs. Only cite numbers that exist.
- Pick the service from the catalogue by its exact id. If no service genuinely fits, leave serviceId and serviceName empty, set fitScore to 0 and explain in noServiceReason. Recommending nothing is better than a weak match.
- Outcomes:
  - qualified: matches the targeting criteria on verified evidence, and a service fits.
  - unqualified: verified evidence shows a clear mismatch (wrong industry, size, region, or explicitly excluded).
  - needs_research: too little verified evidence to judge either way.
  - human_review: the evidence is mixed, borderline or contradictory; a person should decide.
- Be honest and conservative. An unnecessary email costs our reputation.`;

/** Evidence numbered E1..En, matching the indices the model cites back. */
export function numberedEvidence(p: Persona): string {
  const evidence = p.evidence ?? [];
  if (evidence.length === 0) return "(no evidence items)";
  return evidence
    .map((e, i) => `E${i + 1} [${e.basis.toUpperCase()}${e.sourceUrl ? `, ${e.sourceUrl}` : ""}] (${e.category}) ${e.claim}`)
    .join("\n");
}

export function qualifyUserMessage(input: QualifyInput): string {
  const p = input.persona;
  return [
    `## Targeting criteria\n${input.targetingCriteria || "(none defined: judge fit against our company profile and the services' target audiences)"}`,
    `## Our company profile\n${input.companyProfile || "(none provided)"}`,
    `## Service catalogue\n${input.services.map((s) => serviceBlock(s)).join("\n\n") || "(no services)"}`,
    `## Lead\n${leadBlock(input.lead)}`,
    `## Research summary\nCompany: ${p.companySummary}\nIndustry: ${p.industry}\nSize: ${p.companySizeSignal}\nPerson: ${p.personRoleSummary}\nResearch confidence: ${p.confidence}\nResearch status: ${input.researchStatus ?? "unknown"}${
      input.researchIssues.length ? ` (gaps: ${input.researchIssues.join(", ")})` : ""
    }`,
    `## Evidence\n${numberedEvidence(p)}`,
    `## Opportunities suggested by research (inferred)\n${(p.opportunities ?? []).map((o) => `- ${o.opportunity}: ${o.rationale}`).join("\n") || "(none)"}`,
    `Qualify this lead and match a service now.`,
  ].join("\n\n");
}

export function draftSystemBlocks(instr: InstructionBundle, services: ServiceRow[], hardRules: HardRules): string[] {
  const blocks: string[] = [];
  blocks.push(`You write first-touch and follow-up B2B outreach emails on behalf of our company. You are precise, human, and never salesy. You never fabricate facts about the recipient; you only use facts present in the persona or the lead record. You write plain text (no markdown, no bullet lists unless the format guide allows them).

Output requirements:
- Choose the 1-2 best-fit services from the catalogue and explain why.
- Write a subject line and a body. The body must NOT include a greeting placeholder, a signature, or an unsubscribe line; those are appended automatically. Start with the greeting line itself (e.g. "Hi Priya,").
- Respect the tone, format and rules documents below exactly. Hard limits are enforced by an automated validator; drafts that break them are sent back to you.`);

  blocks.push(`## Our company profile\n${instr.companyProfile || "(none provided)"}`);
  blocks.push(`## Service catalogue\n${services.map((s) => serviceBlock(s)).join("\n\n") || "(no services)"}`);
  blocks.push(`## Tone guide\n${instr.tone || "Professional, warm, concise. No hype, no exclamation marks, no buzzwords."}`);
  blocks.push(
    `## Format guide\n${instr.format || "Greeting on its own line. 2-4 short paragraphs. One clear call to action. Under 150 words."}`,
  );
  blocks.push(`## Rules\n${instr.rules || "(none provided)"}`);
  if (instr.followupGuidance) blocks.push(`## Follow-up guidance\n${instr.followupGuidance}`);
  if (instr.other) blocks.push(`## Additional instructions\n${instr.other}`);
  blocks.push(
    `## Hard limits (validator)\n` +
      [
        `- Body length: ${hardRules.minWords}-${hardRules.maxWords} words`,
        `- Subject: max ${hardRules.maxSubjectChars} characters`,
        hardRules.bannedPhrases.length ? `- Never use these phrases: ${hardRules.bannedPhrases.join(", ")}` : "",
        hardRules.requiredPhrases.length ? `- Must include: ${hardRules.requiredPhrases.join(", ")}` : "",
        hardRules.forbidLinks ? "- No links at all" : `- At most ${hardRules.maxLinks} links`,
        hardRules.forbidEmojis ? "- No emojis" : "",
        hardRules.forbidExclamation ? "- No exclamation marks" : "",
        hardRules.forbidAllCapsWords ? "- No words in ALL CAPS (acronyms up to 4 letters are fine)" : "",
        "- No placeholders like [Name] or {{company}}; use the real values or omit.",
      ]
        .filter(Boolean)
        .join("\n"),
  );
  return blocks;
}

export function draftUserMessage(input: DraftInput): string {
  const persona = personaBlock(input.persona);
  const prev = input.previousEmails.length
    ? input.previousEmails
        .map(
          (e) =>
            `--- ${e.direction === "outbound" ? `Our email, step ${e.step}` : "Their reply"} (${e.sentAt ?? "unsent"}) ---\nSubject: ${e.subject}\n${e.bodyText}`,
        )
        .join("\n\n")
    : "(none — this is the first email)";
  const parts = [
    `## Lead\n${leadBlock(input.lead)}`,
    `## Persona (research)\n${persona}`,
    `## Sequence position\nStep ${input.step.step} of ${input.totalSteps}. ${
      input.step.step === 1 ? "This is the initial outreach." : `This is follow-up #${input.step.step - 1}.`
    }\nStep guidance: ${input.step.guidance || "(none)"}`,
    `## Previous emails in this thread\n${prev}`,
  ];
  const q = input.qualification;
  if (q?.service) {
    parts.push(
      `## Recommended service (from qualification; pitch this one)\n${q.service.serviceName} (id ${q.service.serviceId}, fit ${q.service.fitScore}/10)\nWhy: ${q.service.rationale}`,
    );
  }
  if (input.campaignGuidance) parts.push(`## Campaign guidance\n${input.campaignGuidance}`);
  if (input.regenerationFeedback) {
    parts.push(`## Feedback on the previous draft (must be addressed)\n${input.regenerationFeedback}`);
  }
  parts.push(
    `## Sender\nThe email is signed by ${input.senderName}. Do not write the signature.\n\nWrite the email now.`,
  );
  return parts.join("\n\n");
}

export function personaBlock(p: Persona): string {
  return [
    `Company summary: ${p.companySummary}`,
    `Offering: ${p.companyOffering.join("; ")}`,
    `Industry: ${p.industry}`,
    `Size signal: ${p.companySizeSignal}`,
    `Person role: ${p.personRoleSummary}`,
    `Likely priorities: ${p.likelyPriorities.join("; ")}`,
    `Pain points: ${p.painPoints.join("; ")}`,
    `Recent signals: ${p.recentSignals.join("; ") || "(none)"}`,
    `Personalisation hooks: ${p.personalisationHooks.join("; ") || "(none)"}`,
    ...evidenceLines(p),
    `Confidence: ${p.confidence}`,
    `Notes: ${p.notes}`,
  ].join("\n");
}

/**
 * Evidence split into verified facts and inferences, so the drafter states only verified items
 * as facts. Personas stored before evidence existed have no `evidence` and add nothing.
 */
function evidenceLines(p: Persona): string[] {
  const evidence = p.evidence ?? [];
  const opportunities = p.opportunities ?? [];
  if (evidence.length === 0 && opportunities.length === 0) return [];
  const verified = evidence.filter((e) => e.basis === "verified");
  const inferred = evidence.filter((e) => e.basis !== "verified");
  return [
    `Verified facts (safe to state as fact): ${verified.map((e) => `${e.claim} [${e.sourceUrl}]`).join("; ") || "(none)"}`,
    `Inferences (do NOT state as fact; hedge or omit): ${inferred.map((e) => e.claim).join("; ") || "(none)"}`,
    `Opportunities (inferred): ${opportunities.map((o) => `${o.opportunity}${o.relatedService ? ` -> ${o.relatedService}` : ""}`).join("; ") || "(none)"}`,
  ];
}
