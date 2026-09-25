import { describe, expect, it } from "vitest";
import { HardRulesSchema } from "@mailapp/shared";
import { countWords, describeIssues, validateDraft } from "../../src/modules/pipeline/validator.js";

const rules = HardRulesSchema.parse({ minWords: 5, maxWords: 40, bannedPhrases: ["limited time offer"], requiredPhrases: [], doNotContactDomains: ["competitor.com"] });
const good = "Hi Ann,\n\nI noticed Acme opened a new depot in Leeds. Teams like yours often struggle with idle time.\n\nWould a short call next week be useful?";

describe("validateDraft", () => {
  it("accepts a compliant draft", () => {
    const r = validateDraft("Idle time at Acme", good, rules);
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.wordCount).toBe(countWords(good));
  });

  it("flags word limits, banned phrases, emoji, placeholders and all caps", () => {
    const bad = `${good} This is a LIMITED TIME OFFER for [Company] 🚀 ${"pad ".repeat(40)}`;
    const r = validateDraft("x".repeat(100), bad, rules);
    expect(r.ok).toBe(false);
    const rulesHit = r.issues.map((i) => i.rule);
    expect(rulesHit).toEqual(expect.arrayContaining(["subject_length", "max_words", "banned_phrase", "emoji", "placeholder", "all_caps"]));
    expect(describeIssues(r)).toContain("banned phrase");
  });

  it("enforces link limits and do-not-contact domains", () => {
    const withLinks = `${good} See https://a.com and https://b.com and https://c.com`;
    const r = validateDraft("s", withLinks, { ...rules, maxLinks: 2 }, { toEmail: "x@competitor.com" });
    expect(r.linkCount).toBe(3);
    expect(r.issues.map((i) => i.rule)).toEqual(expect.arrayContaining(["max_links", "do_not_contact_domain"]));
    const r2 = validateDraft("s", withLinks, { ...rules, forbidLinks: true });
    expect(r2.issues.map((i) => i.rule)).toContain("links_forbidden");
  });

  it("warns on clichés without failing", () => {
    const r = validateDraft("s", `I hope this email finds you well. ${good}`, rules);
    expect(r.ok).toBe(true);
    expect(r.issues.find((i) => i.rule === "cliche")?.severity).toBe("warning");
  });

  it("requires required phrases and forbids exclamation when configured", () => {
    const r = validateDraft("s", `${good}!`, { ...rules, requiredPhrases: ["no obligation"], forbidExclamation: true });
    expect(r.issues.map((i) => i.rule)).toEqual(expect.arrayContaining(["required_phrase", "exclamation"]));
  });
});
