/**
 * Canonical headers for the lead upload sheet. The importer maps sheet headers to these
 * canonical keys case-insensitively, ignoring spaces/underscores/dashes, and via aliases.
 * Unknown columns are preserved as `extra` and echoed back in the status export.
 */
export const LEAD_COLUMNS = {
  email: { required: true, aliases: ["email", "email address", "e-mail", "work email", "mail"] },
  first_name: { required: false, aliases: ["first name", "firstname", "given name", "name"] },
  last_name: { required: false, aliases: ["last name", "lastname", "surname", "family name"] },
  company: { required: false, aliases: ["company", "company name", "organisation", "organization", "account"] },
  website: { required: false, aliases: ["website", "company website", "url", "domain", "site"] },
  job_title: { required: false, aliases: ["job title", "title", "position", "role", "designation"] },
  linkedin_url: { required: false, aliases: ["linkedin", "linkedin url", "linkedin profile"] },
  industry: { required: false, aliases: ["industry", "sector", "vertical"] },
  location: { required: false, aliases: ["location", "city", "country", "region"] },
  phone: { required: false, aliases: ["phone", "phone number", "mobile"] },
  notes: { required: false, aliases: ["notes", "comments", "context", "remarks"] },
} as const;

export type LeadColumnKey = keyof typeof LEAD_COLUMNS;
export const LEAD_COLUMN_KEYS = Object.keys(LEAD_COLUMNS) as LeadColumnKey[];

/** Columns appended by the status export. */
export const EXPORT_STATUS_COLUMNS = [
  "status",
  "current_step",
  "matched_services",
  "subject",
  "ses_message_id",
  "sent_at",
  "delivered_at",
  "opened_at",
  "clicked_at",
  "replied_at",
  "bounced_at",
  "complained_at",
  "unsubscribed_at",
  "last_error",
  "last_updated_at",
] as const;
export type ExportStatusColumn = (typeof EXPORT_STATUS_COLUMNS)[number];

/** Headers accepted for the services catalogue sheet. */
export const SERVICE_COLUMNS = {
  name: { required: true, aliases: ["name", "service", "service name", "offering"] },
  description: { required: true, aliases: ["description", "details", "summary"] },
  target_audience: { required: false, aliases: ["target audience", "audience", "ideal customer", "icp"] },
  value_props: { required: false, aliases: ["value props", "value propositions", "benefits", "value"] },
  proof_points: { required: false, aliases: ["proof points", "case studies", "proof", "results"] },
  url: { required: false, aliases: ["url", "link", "landing page"] },
  tags: { required: false, aliases: ["tags", "keywords", "categories"] },
} as const;
export type ServiceColumnKey = keyof typeof SERVICE_COLUMNS;

/** Normalise a header string for alias matching. */
export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[\s_\-./]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/**
 * Build a mapping from sheet header (as it appears) -> canonical key.
 * Returns { mapped, unmapped, missingRequired }.
 */
export function mapHeaders<K extends string>(
  headers: string[],
  spec: Record<K, { required: boolean; aliases: readonly string[] }>,
): { mapped: Record<string, K>; unmapped: string[]; missingRequired: K[] } {
  const aliasIndex = new Map<string, K>();
  for (const key of Object.keys(spec) as K[]) {
    aliasIndex.set(normalizeHeader(key), key);
    for (const a of spec[key].aliases) aliasIndex.set(normalizeHeader(a), key);
  }
  const mapped: Record<string, K> = {};
  const unmapped: string[] = [];
  const seen = new Set<K>();
  for (const h of headers) {
    if (!h || !h.trim()) continue;
    const key = aliasIndex.get(normalizeHeader(h));
    if (key && !seen.has(key)) {
      mapped[h] = key;
      seen.add(key);
    } else {
      unmapped.push(h);
    }
  }
  const missingRequired = (Object.keys(spec) as K[]).filter((k) => spec[k].required && !seen.has(k));
  return { mapped, unmapped, missingRequired };
}
