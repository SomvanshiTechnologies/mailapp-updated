import { z } from "zod";
import {
  APPROVAL_MODES,
  CAMPAIGN_ACCESS_LEVELS,
  CAMPAIGN_STATUSES,
  DASHBOARD_SCOPES,
  DELIVERY_MODES,
  INSTRUCTION_KINDS,
  LEAD_STATUSES,
  SUPPRESSION_REASONS,
  USER_ROLES,
} from "./enums.js";
import { BATCH_STRATEGIES, CONFIGURABLE_PROVIDERS, RESEARCH_MODES, findModelSpec, parseModelChoice } from "./models.js";

// ---------- Auth ----------
export const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
});
export type LoginInput = z.infer<typeof LoginSchema>;

const optionalEmail = z.string().email().max(254).optional().or(z.literal(""));

/** Per-user sender identity. Empty/undefined fields fall back to the organisation settings. */
export const SenderProfileSchema = z.object({
  fromEmail: optionalEmail,
  fromName: z.string().max(120).optional().or(z.literal("")),
  replyTo: optionalEmail,
  postalAddress: z.string().max(300).optional().or(z.literal("")),
});
export type SenderProfileInput = z.infer<typeof SenderProfileSchema>;

/**
 * Per-user IMAP mailbox the worker polls for replies (fallback for users whose Reply-To is
 * their own mailbox rather than the SES inbound domain). `imapPassword` is write-only: omit
 * it to keep the stored one, send "" to clear it.
 */
export const ImapSettingsSchema = z.object({
  imapEnabled: z.boolean().optional(),
  imapHost: z.string().max(253).optional().or(z.literal("")),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapUser: z.string().max(254).optional().or(z.literal("")),
  imapPassword: z.string().max(500).optional(),
  imapMailbox: z.string().max(200).optional().or(z.literal("")),
});
export type ImapSettingsInput = z.infer<typeof ImapSettingsSchema>;

export const CreateUserSchema = SenderProfileSchema.extend({
  email: z.string().email().max(254),
  name: z.string().min(1).max(120),
  password: z.string().min(12).max(200),
  role: z.enum(USER_ROLES),
  dashboardScope: z.enum(DASHBOARD_SCOPES).default("own"),
});
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = SenderProfileSchema.merge(ImapSettingsSchema).extend({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(USER_ROLES).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(12).max(200).optional(),
  dashboardScope: z.enum(DASHBOARD_SCOPES).optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

/** What a user may change about themselves. */
export const UpdateProfileSchema = SenderProfileSchema.merge(ImapSettingsSchema).extend({
  name: z.string().min(1).max(120).optional(),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(12).max(200),
});

// ---------- Campaign access ----------
export const GrantCampaignAccessSchema = z.object({
  userId: z.string().uuid(),
  level: z.enum(CAMPAIGN_ACCESS_LEVELS),
});
export type GrantCampaignAccessInput = z.infer<typeof GrantCampaignAccessSchema>;

// ---------- Model selection / AI configuration ----------

/**
 * A stored model selection: a catalogue key, optionally "@batch". Validated against the
 * catalogue so a typo cannot silently send requests to a model that does not exist.
 */
export const ModelSelectionSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((v) => parseModelChoice(v) !== null, { message: "Unknown model" });

/**
 * Same, but a value that no longer resolves (a model retired since the row was written)
 * normalises to `fallback` instead of failing. Used where settings are read back from the
 * database, so a stale model id can never lock an administrator out of the settings page.
 */
export const lenientModelSelection = (fallback: string) =>
  z
    .string()
    .max(120)
    .catch(fallback)
    .transform((v) => parseModelChoice(v)?.value ?? fallback);

/** Per-1M-token rate override for one model, set by an administrator. */
export const ModelRateOverrideSchema = z.object({
  input: z.number().min(0).max(10_000),
  output: z.number().min(0).max(10_000),
  cacheRead: z.number().min(0).max(10_000).nullable().optional(),
  cacheWrite: z.number().min(0).max(10_000).nullable().optional(),
});
export type ModelRateOverride = z.infer<typeof ModelRateOverrideSchema>;

/**
 * Rate overrides keyed by catalogue key ("openai:gpt-6-sol"). Unknown keys are rejected so
 * the table cannot drift away from the catalogue.
 */
export const ModelRateOverridesSchema = z
  .record(z.string(), ModelRateOverrideSchema)
  .refine((rec) => Object.keys(rec).every((k) => findModelSpec(k) !== null), { message: "Rate override for an unknown model" });

/**
 * Which models a campaign uses and how hard research digs. Every field is optional on a
 * campaign: an absent field inherits the organisation setting.
 */
export const CampaignAiConfigSchema = z.object({
  researchModel: ModelSelectionSchema.optional(),
  draftModel: ModelSelectionSchema.optional(),
  researchMode: z.enum(RESEARCH_MODES).optional(),
  batchStrategy: z.enum(BATCH_STRATEGIES).optional(),
});
export type CampaignAiConfig = z.infer<typeof CampaignAiConfigSchema>;

/** Provider credentials supplied from the dashboard. Write-only; never returned. */
export const ProviderCredentialSchema = z.object({
  apiKey: z.string().min(8).max(500),
  /** Override the provider base URL (self-hosted gateways, Azure-style endpoints). */
  baseUrl: z.string().url().max(500).optional().or(z.literal("")),
});
export type ProviderCredentialInput = z.infer<typeof ProviderCredentialSchema>;

export const ProviderParamSchema = z.enum(CONFIGURABLE_PROVIDERS);

// ---------- Hard rules (deterministic validator) ----------
export const HardRulesSchema = z.object({
  maxWords: z.number().int().min(20).max(1000).default(180),
  minWords: z.number().int().min(0).max(500).default(40),
  maxSubjectChars: z.number().int().min(10).max(200).default(80),
  bannedPhrases: z.array(z.string().min(1)).default([]),
  requiredPhrases: z.array(z.string().min(1)).default([]),
  forbidLinks: z.boolean().default(false),
  maxLinks: z.number().int().min(0).max(10).default(2),
  forbidEmojis: z.boolean().default(true),
  forbidExclamation: z.boolean().default(false),
  forbidAllCapsWords: z.boolean().default(true),
  requireUnsubscribeFooter: z.boolean().default(true),
  doNotContactDomains: z.array(z.string().min(1)).default([]),
  /** Local-hour send window, e.g. 9..17 in `timezone`. */
  sendWindowStartHour: z.number().int().min(0).max(23).default(8),
  sendWindowEndHour: z.number().int().min(1).max(24).default(18),
  sendDays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  timezone: z.string().default("UTC"),
});
export type HardRules = z.infer<typeof HardRulesSchema>;

// ---------- Sequence / follow-ups ----------
export const SequenceStepSchema = z.object({
  step: z.number().int().min(1),
  /** Days after the previous step was sent. Step 1 is always 0. */
  delayDays: z.number().int().min(0).max(90),
  /** Free-text guidance for the LLM for this step (e.g. "short bump, reference previous email"). */
  guidance: z.string().max(2000).default(""),
  /** Continue the same thread (Re: subject, In-Reply-To). */
  threaded: z.boolean().default(true),
});
export type SequenceStep = z.infer<typeof SequenceStepSchema>;

export const SequenceSchema = z
  .array(SequenceStepSchema)
  .min(1)
  .max(8)
  .refine((steps) => steps.every((s, i) => s.step === i + 1), {
    message: "Steps must be numbered 1..n in order",
  })
  .refine((steps) => steps.length === 0 || steps[0].delayDays === 0, { message: "Step 1 must have delayDays = 0" });
export type Sequence = z.infer<typeof SequenceSchema>;

export const DEFAULT_SEQUENCE: Sequence = [
  { step: 1, delayDays: 0, guidance: "Initial personalised outreach.", threaded: true },
  {
    step: 2,
    delayDays: 3,
    guidance: "Short, polite bump. Add one new angle or proof point. Do not repeat the first email.",
    threaded: true,
  },
  {
    step: 3,
    delayDays: 5,
    guidance: "Final, brief note. Offer an easy out and a single clear ask.",
    threaded: true,
  },
];

// ---------- Campaigns ----------
export const CreateCampaignSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional().default(""),
  approvalMode: z.enum(APPROVAL_MODES).default("manual"),
  sequence: SequenceSchema.default(DEFAULT_SEQUENCE),
  /** Restrict matching to these service ids (empty = all active services). */
  serviceIds: z.array(z.string().uuid()).default([]),
  fromEmail: z.string().email().optional(),
  fromName: z.string().max(120).optional(),
  replyTo: z.string().email().optional(),
  /** Extra per-campaign guidance appended to the instruction docs. */
  extraGuidance: z.string().max(5000).optional().default(""),
  hardRulesOverride: HardRulesSchema.partial().optional(),
  /**
   * Model / research-intensity overrides for this campaign. Omitted or empty fields inherit
   * the organisation settings, so a campaign only stores what it deliberately changed.
   */
  aiConfig: CampaignAiConfigSchema.optional(),
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;

export const UpdateCampaignSchema = CreateCampaignSchema.partial();
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignSchema>;

export const CampaignStatusSchema = z.enum(CAMPAIGN_STATUSES);

// ---------- Leads ----------
export const LeadStatusSchema = z.enum(LEAD_STATUSES);

export const LeadListQuerySchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------- Services ----------
export const ServiceSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().min(1).max(5000),
  targetAudience: z.string().max(2000).optional().default(""),
  valueProps: z.array(z.string().max(500)).max(20).default([]),
  proofPoints: z.array(z.string().max(500)).max(20).default([]),
  url: z.string().url().optional().or(z.literal("")).default(""),
  tags: z.array(z.string().max(50)).max(20).default([]),
  isActive: z.boolean().default(true),
});
export type ServiceInput = z.infer<typeof ServiceSchema>;

// ---------- Instructions ----------
export const InstructionSchema = z.object({
  kind: z.enum(INSTRUCTION_KINDS),
  title: z.string().min(1).max(160),
  content: z.string().min(1).max(50_000),
  isActive: z.boolean().default(true),
});
export type InstructionInput = z.infer<typeof InstructionSchema>;

/** "org" = organisation-wide docs (admin managed); "mine" = the caller's personal docs. */
export const INSTRUCTION_SCOPES = ["org", "mine"] as const;
export type InstructionScope = (typeof INSTRUCTION_SCOPES)[number];

// ---------- Email review ----------
export const ReviewEmailSchema = z.object({
  subject: z.string().min(1).max(300).optional(),
  bodyText: z.string().min(1).max(20_000).optional(),
  note: z.string().max(2000).optional(),
});
export type ReviewEmailInput = z.infer<typeof ReviewEmailSchema>;

export const RegenerateEmailSchema = z.object({
  feedback: z.string().max(2000).optional(),
});

// ---------- Suppressions ----------
export const SuppressionSchema = z.object({
  email: z.string().email(),
  reason: z.enum(SUPPRESSION_REASONS).default("manual"),
  note: z.string().max(500).optional(),
});

// ---------- Preferences / unsubscribe landing page ----------
export const LandingServiceSchema = z.object({
  serviceId: z.string().uuid(),
  /** Show the "Learn more" button (service url). */
  showLink: z.boolean().default(true),
  /** Show the direct contact button. */
  showContact: z.boolean().default(true),
  /** Contact button target for this service (URL or mailto:). Empty = mailto to the page contact email. */
  contactUrl: z.string().max(500).optional().or(z.literal("")),
});
export type LandingService = z.infer<typeof LandingServiceSchema>;

/**
 * What a recipient sees when they click the link at the bottom of an email: a short intro,
 * the services we offer (with link / contact buttons) and, optionally, a small unsubscribe button.
 */
export const LandingPageSchema = z.object({
  headline: z.string().max(160).default("A little about what we do"),
  intro: z.string().max(2000).default(""),
  /** Text of the small link in outgoing emails that points at this page. */
  emailLinkLabel: z.string().min(1).max(80).default("Manage preferences"),
  /** Off by default: outreach goes to known contacts who opt out by replying; one-click unsubscribe from mail clients still works. */
  showUnsubscribe: z.boolean().default(false),
  unsubscribeLabel: z.string().min(1).max(80).default("Unsubscribe"),
  unsubscribeNote: z.string().max(300).default("Prefer not to hear from us? One click and we stop."),
  contactEmail: z.string().email().max(254).optional().or(z.literal("")),
  contactLabel: z.string().min(1).max(80).default("Contact us"),
  linkLabel: z.string().min(1).max(80).default("Learn more"),
  /** Services to show, in order. Empty = every active service with default buttons. */
  services: z.array(LandingServiceSchema).max(50).default([]),
  footerNote: z.string().max(500).default(""),
});
export type LandingPage = z.infer<typeof LandingPageSchema>;
export const DEFAULT_LANDING_PAGE: LandingPage = LandingPageSchema.parse({});

// ---------- Settings ----------
export const SettingsSchema = z.object({
  fromEmail: z.string().email(),
  fromName: z.string().max(120),
  replyTo: z.string().email().optional().or(z.literal("")),
  configurationSet: z.string().max(120).optional().or(z.literal("")),
  dailyCap: z.number().int().min(0).max(1_000_000),
  maxSendRate: z.number().min(0.1).max(1000),
  defaultApprovalMode: z.enum(APPROVAL_MODES),
  /** Organisation default drafting model; campaigns inherit this unless they override it. */
  llmModel: lenientModelSelection("anthropic:claude-opus-5-5"),
  /** Organisation default research model. */
  researchModel: lenientModelSelection("anthropic:claude-opus-5-5"),
  /** How hard research digs by default. */
  researchMode: z.enum(RESEARCH_MODES).default("great"),
  /** Grouping used when a selected model is a batch model. */
  batchStrategy: z.enum(BATCH_STRATEGIES).default("rolling"),
  /** Rolling batches flush once the oldest queued request is this old. */
  batchFlushMinutes: z.number().int().min(1).max(720).default(15),
  /** ...or once this many requests are queued for the same model and purpose. */
  batchMaxRequests: z.number().int().min(1).max(50_000).default(500),
  /**
   * Refuse to start a campaign whose estimated spend exceeds this many US dollars.
   * 0 disables the check.
   */
  campaignCostCapUsd: z.number().min(0).max(1_000_000).default(0),
  /** Administrator overrides of the catalogue's list prices, keyed by model. */
  modelRateOverrides: ModelRateOverridesSchema.default({}),
  webSearchEnabled: z.boolean(),
  /**
   * SES can only measure opens when an HTML part is sent. In "personal" delivery mode,
   * trackOpens=false sends plain text only (best inbox placement, no open tracking) and
   * trackOpens=true sends a minimal unstyled HTML mirror so SES can add its open pixel.
   */
  trackOpens: z.boolean(),
  trackClicks: z.boolean(),
  /** Shape of the outbound message; see DELIVERY_MODES. */
  deliveryMode: z.enum(DELIVERY_MODES).default("personal"),
  /**
   * When a reply arrives through the SES inbound domain (which no human mailbox reads),
   * forward it to the campaign owner's real mailbox with Reply-To set to the lead.
   */
  forwardRepliesToOwner: z.boolean().default(true),
  landingPage: LandingPageSchema.default(DEFAULT_LANDING_PAGE),
  hardRules: HardRulesSchema,
  /** Physical mailing address printed in the footer (CAN-SPAM). */
  postalAddress: z.string().max(300).optional().or(z.literal("")),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  fromEmail: "outreach@example.com",
  fromName: "Outreach Team",
  replyTo: "",
  configurationSet: "",
  dailyCap: 500,
  maxSendRate: 2,
  defaultApprovalMode: "manual",
  llmModel: "anthropic:claude-opus-5-5",
  researchModel: "anthropic:claude-opus-5-5",
  researchMode: "great",
  batchStrategy: "rolling",
  batchFlushMinutes: 15,
  batchMaxRequests: 500,
  campaignCostCapUsd: 0,
  modelRateOverrides: {},
  webSearchEnabled: true,
  trackOpens: true,
  trackClicks: true,
  deliveryMode: "personal",
  forwardRepliesToOwner: true,
  landingPage: DEFAULT_LANDING_PAGE,
  hardRules: HardRulesSchema.parse({}),
  postalAddress: "",
};

// ---------- Analytics ----------
export const DateRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  campaignId: z.string().uuid().optional(),
});
