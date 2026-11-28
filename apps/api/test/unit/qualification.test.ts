import { describe, expect, it } from "vitest";
import { QualificationOutputSchema, type EvidenceItem, type Persona, type QualificationOutput } from "@mailapp/shared";
import { finaliseQualification, humanQualification, leadStatusForOutcome, preQualify } from "../../src/modules/pipeline/qualification.js";
import { numberedEvidence, qualifyUserMessage } from "../../src/modules/llm/prompts.js";

const SITE = "https://acme.example.com/";
const SERVICES = [
  { id: "11111111-1111-1111-1111-111111111111", name: "Fleet Automation" },
  { id: "22222222-2222-2222-2222-222222222222", name: "Data Platform" },
];

const v = (claim: string): EvidenceItem => ({ claim, category: "company", basis: "verified", sourceUrl: SITE, excerpt: claim });
const inf = (claim: string): EvidenceItem => ({ claim, category: "person", basis: "inferred", sourceUrl: "", excerpt: "" });

function persona(evidence: EvidenceItem[] = [v("Acme runs 300 delivery vans"), v("Acme operates in the UK"), inf("Ops team is stretched")]): Persona {
  return {
    companySummary: "Acme is a logistics company.",
    companyOffering: ["delivery"],
    industry: "logistics",
    companySizeSignal: "200-500 employees",
    personRoleSummary: "Head of operations",
    likelyPriorities: [],
    painPoints: [],
    recentSignals: [],
    personalisationHooks: [],
    sources: [SITE],
    evidence,
    opportunities: [],
    confidence: "high",
    notes: "",
  };
}

function output(over: Partial<QualificationOutput> = {}, match: Partial<QualificationOutput["serviceMatch"]> = {}): QualificationOutput {
  return {
    outcome: "qualified",
    confidence: "high",
    summary: "Good fit.",
    criteria: [{ criterion: "Logistics company", assessment: "met", evidenceRefs: [1], note: "" }],
    serviceMatch: { serviceId: SERVICES[0].id, serviceName: SERVICES[0].name, fitScore: 8, rationale: "Large fleet.", evidenceRefs: [1], ...match },
    noServiceReason: "",
    ...over,
  };
}

const opts = (p = persona()) => ({ persona: p, services: SERVICES, minFitScore: 5, model: "mock" });

describe("preQualify", () => {
  it("asks the model when there is verified evidence", () => {
    expect(preQualify(persona())).toBeNull();
  });
  it("sends leads with no verified evidence to needs_research without a model call", () => {
    const r = preQualify(persona([inf("Probably B2B")]))!;
    expect(r.outcome).toBe("needs_research");
    expect(r.decidedBy).toBe("rules");
    expect(r.modelOutcome).toBeNull();
    expect(r.service).toBeNull();
  });
  it("handles a lead with no research", () => {
    expect(preQualify(null)!.outcome).toBe("needs_research");
  });
});

describe("finaliseQualification", () => {
  it("keeps a well-supported qualified decision and resolves cited evidence", () => {
    const r = finaliseQualification(output(), opts());
    expect(r.outcome).toBe("qualified");
    expect(r.decidedBy).toBe("ai");
    expect(r.adjustments).toEqual([]);
    expect(r.service).toMatchObject({ serviceId: SERVICES[0].id, serviceName: "Fleet Automation", fitScore: 8 });
    expect(r.service!.supportingEvidence[0].claim).toBe("Acme runs 300 delivery vans");
    expect(r.criteria[0].evidence).toHaveLength(1);
    expect(r.noServiceReason).toBe("");
  });

  it("supports the no-suitable-service case: qualified with no service goes to human review", () => {
    const r = finaliseQualification(output({ noServiceReason: "Nothing fits." }, { serviceId: "", serviceName: "", fitScore: 0, evidenceRefs: [] }), opts());
    expect(r.outcome).toBe("human_review");
    expect(r.service).toBeNull();
    expect(r.noServiceReason).toBe("Nothing fits.");
    expect(r.decidedBy).toBe("rules");
  });

  it("discards a service that is not in the catalogue", () => {
    const r = finaliseQualification(output({}, { serviceId: "99999999-9999-9999-9999-999999999999", serviceName: "Made Up Service" }), opts());
    expect(r.service).toBeNull();
    expect(r.outcome).toBe("human_review");
    expect(r.adjustments.join(" ")).toMatch(/not in this campaign's service catalogue/);
  });

  it("matches by exact name when the id is wrong", () => {
    const r = finaliseQualification(output({}, { serviceId: "wrong", serviceName: "data platform" }), opts());
    expect(r.service!.serviceId).toBe(SERVICES[1].id);
    expect(r.outcome).toBe("qualified");
    expect(r.adjustments[0]).toMatch(/matched "Data Platform" by name/);
  });

  it("sends qualified to human review when the service rests only on inferred evidence", () => {
    const r = finaliseQualification(output({}, { evidenceRefs: [3] }), opts());
    expect(r.outcome).toBe("human_review");
    expect(r.service).not.toBeNull(); // kept so the reviewer can see the suggestion
    expect(r.adjustments.join(" ")).toMatch(/not supported by any verified evidence/);
  });

  it("sends qualified to human review when the fit score is below the minimum", () => {
    const r = finaliseQualification(output({}, { fitScore: 3 }), opts());
    expect(r.outcome).toBe("human_review");
    expect(r.adjustments.join(" ")).toMatch(/3\/10 is below the minimum of 5/);
  });

  it("drops citations to evidence that does not exist", () => {
    const r = finaliseQualification(output({}, { evidenceRefs: [1, 42, 0] }), opts());
    expect(r.service!.supportingEvidence).toHaveLength(1);
    expect(r.adjustments.join(" ")).toMatch(/Ignored 2 citation/);
    expect(r.outcome).toBe("qualified");
  });

  it("clears the service on unqualified and needs_research outcomes", () => {
    expect(finaliseQualification(output({ outcome: "unqualified" }), opts()).service).toBeNull();
    expect(finaliseQualification(output({ outcome: "needs_research" }), opts()).service).toBeNull();
  });

  it("keeps human_review from the model as is, with its suggested service", () => {
    const r = finaliseQualification(output({ outcome: "human_review" }), opts());
    expect(r.outcome).toBe("human_review");
    expect(r.decidedBy).toBe("ai");
    expect(r.service).not.toBeNull();
  });
});

describe("leadStatusForOutcome", () => {
  it("maps outcomes to pipeline statuses", () => {
    expect(leadStatusForOutcome("qualified")).toBe("qualified");
    expect(leadStatusForOutcome("unqualified")).toBe("unqualified");
    expect(leadStatusForOutcome("needs_research")).toBe("on_hold");
    expect(leadStatusForOutcome("human_review")).toBe("on_hold");
  });
});

describe("humanQualification", () => {
  it("records who decided and keeps the earlier reasoning", () => {
    const prior = finaliseQualification(output({}, { fitScore: 3 }), opts());
    const r = humanQualification(prior, { outcome: "qualified", service: prior.service, note: "Known prospect", userEmail: "ops@ours.com" });
    expect(r.outcome).toBe("qualified");
    expect(r.decidedBy).toBe("human");
    expect(r.decidedByUser).toBe("ops@ours.com");
    expect(r.summary).toBe(prior.summary);
    expect(r.adjustments.at(-1)).toBe("Set to qualified by ops@ours.com: Known prospect");
  });
  it("disqualifying removes the service", () => {
    const prior = finaliseQualification(output(), opts());
    expect(humanQualification(prior, { outcome: "unqualified", service: prior.service, note: "", userEmail: "x@y.com" }).service).toBeNull();
  });
});

describe("qualification prompt", () => {
  it("numbers evidence so the model can cite it", () => {
    expect(numberedEvidence(persona())).toBe(
      `E1 [VERIFIED, ${SITE}] (company) Acme runs 300 delivery vans\nE2 [VERIFIED, ${SITE}] (company) Acme operates in the UK\nE3 [INFERRED] (person) Ops team is stretched`,
    );
  });
  it("includes targeting criteria and service ids", () => {
    const msg = qualifyUserMessage({
      lead: { firstName: "Ann", lastName: "Lee", email: "ann@acme.example.com", extra: {} } as never,
      persona: persona(),
      researchStatus: "complete",
      researchIssues: [],
      services: [{ id: SERVICES[0].id, name: "Fleet Automation", description: "Automates fleets", targetAudience: "", valueProps: [], proofPoints: [], tags: [] } as never],
      companyProfile: "We build fleet software.",
      targetingCriteria: "UK logistics companies with 100+ vehicles",
      model: {} as never,
    });
    expect(msg).toContain("UK logistics companies with 100+ vehicles");
    expect(msg).toContain(`Service id: ${SERVICES[0].id}`);
    expect(msg).toContain("E1 [VERIFIED");
  });
  it("output schema accepts a no-service answer", () => {
    expect(QualificationOutputSchema.safeParse(output({}, { serviceId: "", serviceName: "", fitScore: 0, evidenceRefs: [] })).success).toBe(true);
  });
});
