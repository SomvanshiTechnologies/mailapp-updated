import { describe, expect, it } from "vitest";
import { PersonaSchema, type EvidenceItem, type Persona } from "@mailapp/shared";
import { assessResearch, isSourceUrl } from "../../src/modules/pipeline/evidence.js";
import { personaBlock } from "../../src/modules/llm/prompts.js";

const SITE = "https://acme.example.com/";

function verified(claim: string, sourceUrl = SITE): EvidenceItem {
  return { claim, category: "company", basis: "verified", sourceUrl, excerpt: claim };
}
function inferred(claim: string): EvidenceItem {
  return { claim, category: "person", basis: "inferred", sourceUrl: "", excerpt: "" };
}

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    companySummary: "Acme makes widgets.",
    companyOffering: ["widgets"],
    industry: "manufacturing",
    companySizeSignal: "unknown",
    personRoleSummary: "Runs operations.",
    likelyPriorities: ["efficiency"],
    painPoints: ["manual work"],
    recentSignals: [],
    personalisationHooks: [],
    sources: [SITE],
    evidence: [verified("Acme makes widgets"), verified("Acme ships to 12 countries"), inferred("Cares about cost")],
    opportunities: [{ opportunity: "Automate ordering", rationale: "Manual order handling is likely", relatedService: "Automation" }],
    confidence: "high",
    notes: "",
    ...overrides,
  };
}

const fetched = { websiteAttempted: true, websiteFetched: true };

describe("isSourceUrl", () => {
  it("accepts http(s) URLs only", () => {
    expect(isSourceUrl("https://acme.com/about")).toBe(true);
    expect(isSourceUrl("http://acme.com")).toBe(true);
    expect(isSourceUrl("")).toBe(false);
    expect(isSourceUrl("acme website")).toBe(false);
    expect(isSourceUrl("ftp://acme.com")).toBe(false);
    expect(isSourceUrl("https://localhost")).toBe(false);
  });
});

describe("assessResearch", () => {
  it("grades well-sourced research as complete with no issues", () => {
    const r = assessResearch(persona(), fetched);
    expect(r.status).toBe("complete");
    expect(r.issues).toEqual([]);
    expect(r.verifiedCount).toBe(2);
    expect(r.inferredCount).toBe(1);
    expect(r.persona.confidence).toBe("high");
  });

  it("downgrades a verified claim without a usable source to inferred", () => {
    const r = assessResearch(
      persona({ evidence: [verified("A"), verified("B"), verified("Raised a Series B", ""), verified("Has 500 staff", "LinkedIn")] }),
      fetched,
    );
    const funding = r.persona.evidence.find((e) => e.claim === "Raised a Series B")!;
    const staff = r.persona.evidence.find((e) => e.claim === "Has 500 staff")!;
    expect(funding.basis).toBe("inferred");
    expect(staff.basis).toBe("inferred");
    expect(staff.sourceUrl).toBe("");
    expect(r.verifiedCount).toBe(2);
    expect(r.issues).toContain("unsourced_claims_downgraded");
    // A correction on its own does not make the research partial.
    expect(r.status).toBe("complete");
  });

  it("merges cited URLs into sources and drops non-URL sources", () => {
    const r = assessResearch(
      persona({ sources: ["the company website"], evidence: [verified("A", "https://news.example.com/a"), verified("B")] }),
      fetched,
    );
    expect(r.persona.sources).toEqual(["https://news.example.com/a", SITE]);
  });

  it("marks research partial when the website could not be fetched", () => {
    const r = assessResearch(persona(), { websiteAttempted: true, websiteFetched: false });
    expect(r.status).toBe("partial");
    expect(r.issues).toContain("website_unavailable");
  });

  it("marks insufficient research partial and caps confidence at low", () => {
    const r = assessResearch(persona({ sources: [], evidence: [inferred("Probably B2B")], confidence: "medium" }), {
      websiteAttempted: false,
      websiteFetched: false,
    });
    expect(r.status).toBe("partial");
    expect(r.persona.confidence).toBe("low");
    expect(r.issues).toEqual(expect.arrayContaining(["no_website", "no_sources", "few_verified_facts", "low_confidence"]));
  });

  it("treats one verified fact as too few", () => {
    const r = assessResearch(persona({ evidence: [verified("A")] }), fetched);
    expect(r.status).toBe("partial");
    expect(r.issues).toEqual(["few_verified_facts"]);
  });

  it("does not treat a missing website alone as partial when web research found sources", () => {
    const r = assessResearch(persona(), { websiteAttempted: false, websiteFetched: false });
    expect(r.issues).toEqual(["no_website"]);
    expect(r.status).toBe("complete");
  });

  it("tolerates personas stored before evidence existed", () => {
    const legacy = persona();
    delete (legacy as Partial<Persona>).evidence;
    delete (legacy as Partial<Persona>).opportunities;
    const r = assessResearch(legacy, fetched);
    expect(r.persona.evidence).toEqual([]);
    expect(r.persona.opportunities).toEqual([]);
    expect(r.status).toBe("partial");
  });

  it("produces a persona that still satisfies the shared schema", () => {
    const r = assessResearch(persona({ evidence: [verified("x", "")] }), fetched);
    expect(PersonaSchema.safeParse(r.persona).success).toBe(true);
  });
});

describe("personaBlock (downstream consumption)", () => {
  it("separates verified facts from inferences for the drafter", () => {
    const block = personaBlock(persona());
    expect(block).toContain(`Verified facts (safe to state as fact): Acme makes widgets [${SITE}]`);
    expect(block).toMatch(/Inferences \(do NOT state as fact; hedge or omit\): Cares about cost/);
    expect(block).toContain("Opportunities (inferred): Automate ordering -> Automation");
  });

  it("omits evidence lines for legacy personas", () => {
    const legacy = persona();
    delete (legacy as Partial<Persona>).evidence;
    delete (legacy as Partial<Persona>).opportunities;
    expect(personaBlock(legacy)).not.toContain("Verified facts");
  });
});
