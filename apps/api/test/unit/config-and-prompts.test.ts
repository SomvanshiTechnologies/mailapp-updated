import { describe, expect, it } from "vitest";
import { HardRulesSchema, type Persona } from "@mailapp/shared";
import { loadConfig } from "../../src/config.js";
import { draftSystemBlocks, draftUserMessage, leadBlock } from "../../src/modules/llm/prompts.js";
import type { LeadRow, ServiceRow } from "../../src/db/schema.js";

const baseEnv = {
  DATABASE_URL: "postgres://x",
  JWT_SECRET: "a".repeat(40),
  APP_SECRET: "b".repeat(40),
};

describe("config", () => {
  it("applies defaults and derived flags", () => {
    const c = loadConfig(baseEnv);
    expect(c.PORT).toBe(4000);
    expect(c.SES_MODE).toBe("mock");
    expect(c.isProd).toBe(false);
    expect(c.snsAllowedTopicArns).toEqual([]);
  });

  it("rejects short secrets and missing db url", () => {
    expect(() => loadConfig({ ...baseEnv, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ JWT_SECRET: baseEnv.JWT_SECRET, APP_SECRET: baseEnv.APP_SECRET })).toThrow(/DATABASE_URL/);
  });

  it("enforces production guards", () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: "production", LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    const c = loadConfig({ ...baseEnv, NODE_ENV: "production", SNS_VERIFY_SIGNATURES: "false", SNS_ALLOWED_TOPIC_ARNS: "a, b" });
    expect(c.SNS_VERIFY_SIGNATURES).toBe(true);
    expect(c.snsAllowedTopicArns).toEqual(["a", "b"]);
  });
});

const lead = {
  id: "l1",
  campaignId: "c1",
  email: "ann@acme.com",
  firstName: "Ann",
  lastName: null,
  company: "Acme",
  website: "acme.com",
  jobTitle: "COO",
  linkedinUrl: null,
  industry: "Logistics",
  location: null,
  phone: null,
  notes: null,
  extra: { Owner: "sam", Empty: "" },
} as unknown as LeadRow;

const persona: Persona = {
  companySummary: "Acme moves boxes.",
  companyOffering: ["parcels"],
  industry: "Logistics",
  companySizeSignal: "200 staff",
  personRoleSummary: "Runs ops",
  likelyPriorities: ["speed"],
  painPoints: ["idle fleet"],
  recentSignals: [],
  personalisationHooks: ["new depot"],
  sources: [],
  confidence: "medium",
  notes: "",
};

describe("prompts", () => {
  it("renders lead block with extras and omits empty extras", () => {
    const b = leadBlock(lead);
    expect(b).toContain("Name: Ann");
    expect(b).toContain("Other columns: Owner=sam");
    expect(b).not.toContain("Empty=");
  });

  it("builds a stable system prefix and a per-lead user message", () => {
    const rules = HardRulesSchema.parse({ bannedPhrases: ["synergy"] });
    const blocks = draftSystemBlocks(
      { companyProfile: "We are Ours.", tone: "", format: "", rules: "No pricing.", signature: "", followupGuidance: "", other: "" },
      [{ id: "s1", name: "Fleet", description: "d", targetAudience: "", valueProps: ["v"], proofPoints: [], tags: [], url: "" } as unknown as ServiceRow],
      rules,
    );
    const joined = blocks.join("\n");
    expect(joined).toContain("We are Ours.");
    expect(joined).toContain("Service id: s1");
    expect(joined).toContain("Never use these phrases: synergy");
    expect(joined).toContain("No pricing.");
    const user = draftUserMessage({
      lead,
      persona,
      services: [],
      instructions: { companyProfile: "", tone: "", format: "", rules: "", signature: "", followupGuidance: "", other: "" },
      hardRules: rules,
      step: { step: 2, delayDays: 3, guidance: "bump", threaded: true },
      totalSteps: 3,
      previousEmails: [{ step: 1, subject: "First", bodyText: "Hello", sentAt: "2026-01-01T00:00:00Z", direction: "outbound" }],
      campaignGuidance: "Mention the depot.",
      regenerationFeedback: "Too long.",
      senderName: "Sam",
      model: "claude-opus-5",
    });
    expect(user).toContain("Step 2 of 3");
    expect(user).toContain("Our email, step 1");
    expect(user).toContain("Mention the depot.");
    expect(user).toContain("Too long.");
    expect(user).toContain("signed by Sam");
  });
});
