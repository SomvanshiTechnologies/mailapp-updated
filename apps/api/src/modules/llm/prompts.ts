import type { HardRules, Persona } from "@mailapp/shared";
import type { LeadRow, ServiceRow } from "../../db/schema.js";
import type { DraftInput, InstructionBundle, ResearchInput, WebsiteExtract } from "./provider.js";

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

export const RESEARCH_SYSTEM = `You are a B2B sales research analyst. You research a company and a specific person there so that a colleague can write a relevant, honest outreach email.

Ground rules:
- Prefer primary sources (the company website, LinkedIn, press releases, filings, reputable news). Note the URL of each fact.
- Never invent facts. If something is unknown, say so explicitly and lower your confidence.
- Distinguish the company from similarly named companies; use the website domain and location to disambiguate.
- Keep findings concrete: products, customers, pricing model, team size signals, hiring, recent launches, funding, partnerships, tech stack signals, public statements by the person.
- Be concise. Bullet points are fine.`;

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
    ? "Use web search (and fetch pages when useful) to verify and enrich the above."
    : "Do not use external tools; work from the material above and general knowledge, and be explicit about uncertainty."
}
Produce research findings covering: what the company does and for whom; its offering; industry; size/stage signals with evidence; what this person's role likely owns; their likely priorities right now; plausible pain points relevant to our services; recent signals (news, hiring, launches, funding) with dates and URLs; specific personalisation hooks that are verifiable; sources consulted; overall confidence; caveats.`;
}

export const PERSONA_STRUCTURE_SYSTEM = `You convert research findings into a structured persona JSON. Copy facts faithfully from the findings; do not add new claims. If a field has no support in the findings, use an empty list or say "unknown".`;

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
    `Confidence: ${p.confidence}`,
    `Notes: ${p.notes}`,
  ].join("\n");
}
