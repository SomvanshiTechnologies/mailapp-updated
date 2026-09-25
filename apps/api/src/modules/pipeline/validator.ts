import type { HardRules, ValidationIssue, ValidationResult } from "@mailapp/shared";

const URL_RE = /https?:\/\/[^\s)>\]]+/gi;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{2B50}\u{2705}\u{274C}]/u;
const PLACEHOLDER_RE = /\[(?:first[ _-]?name|name|company|title)\]|\{\{[^}]*\}\}|\[[A-Z][A-Za-z _]{2,30}\]/;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Deterministic checks that do not depend on the model. Errors block auto-approval; warnings
 * are surfaced to reviewers.
 */
export function validateDraft(subject: string, bodyText: string, rules: HardRules, opts: { toEmail?: string } = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (rule: string, message: string) => issues.push({ rule, severity: "error", message });
  const warn = (rule: string, message: string) => issues.push({ rule, severity: "warning", message });

  const wordCount = countWords(bodyText);
  const links = bodyText.match(URL_RE) ?? [];

  if (!subject.trim()) err("subject_empty", "Subject is empty");
  if (subject.length > rules.maxSubjectChars) err("subject_length", `Subject is ${subject.length} chars (max ${rules.maxSubjectChars})`);
  if (/^re:/i.test(subject.trim()) === false && /\bre\s*:/i.test(subject)) warn("subject_fake_re", "Subject contains a fake 'Re:'");

  if (wordCount > rules.maxWords) err("max_words", `Body has ${wordCount} words (max ${rules.maxWords})`);
  if (wordCount < rules.minWords) err("min_words", `Body has ${wordCount} words (min ${rules.minWords})`);

  const lower = `${subject}\n${bodyText}`.toLowerCase();
  for (const phrase of rules.bannedPhrases) {
    if (phrase && lower.includes(phrase.toLowerCase())) err("banned_phrase", `Contains banned phrase "${phrase}"`);
  }
  for (const phrase of rules.requiredPhrases) {
    if (phrase && !lower.includes(phrase.toLowerCase())) err("required_phrase", `Missing required phrase "${phrase}"`);
  }

  if (rules.forbidLinks && links.length) err("links_forbidden", `Contains ${links.length} link(s); links are not allowed`);
  else if (links.length > rules.maxLinks) err("max_links", `Contains ${links.length} links (max ${rules.maxLinks})`);

  if (rules.forbidEmojis && EMOJI_RE.test(`${subject}${bodyText}`)) err("emoji", "Contains emoji");
  if (rules.forbidExclamation && /!/.test(`${subject}${bodyText}`)) err("exclamation", "Contains exclamation marks");
  if (rules.forbidAllCapsWords) {
    const caps = bodyText.match(/\b[A-Z]{5,}\b/g) ?? [];
    if (caps.length) err("all_caps", `Contains ALL CAPS words: ${[...new Set(caps)].slice(0, 5).join(", ")}`);
  }
  if (PLACEHOLDER_RE.test(bodyText) || PLACEHOLDER_RE.test(subject)) err("placeholder", "Contains an unfilled placeholder such as [Name] or {{company}}");

  if (opts.toEmail) {
    const domain = opts.toEmail.split("@")[1]?.toLowerCase();
    if (domain && rules.doNotContactDomains.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`))) {
      err("do_not_contact_domain", `Recipient domain ${domain} is on the do-not-contact list`);
    }
  }

  if (/\b(unsubscribe|opt[ -]?out)\b/i.test(bodyText)) warn("unsubscribe_in_body", "Body mentions unsubscribe; the footer already covers this");
  if (/^(dear sir|to whom it may concern)/i.test(bodyText.trim())) warn("generic_greeting", "Generic greeting");
  if (/\bI hope this (email|message) finds you well\b/i.test(bodyText)) warn("cliche", "Contains a cliché opener");

  return { ok: !issues.some((i) => i.severity === "error"), issues, wordCount, linkCount: links.length };
}

/** Human readable summary used as regeneration feedback. */
export function describeIssues(v: ValidationResult): string {
  return v.issues
    .filter((i) => i.severity === "error")
    .map((i) => `- ${i.message}`)
    .join("\n");
}
