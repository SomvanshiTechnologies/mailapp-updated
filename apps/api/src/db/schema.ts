import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  APPROVAL_MODES,
  BATCH_ITEM_STATUSES,
  BATCH_STATUSES,
  BATCH_STRATEGIES,
  CAMPAIGN_ACCESS_LEVELS,
  CAMPAIGN_STATUSES,
  DASHBOARD_SCOPES,
  EMAIL_DIRECTIONS,
  EMAIL_STATUSES,
  FILE_KINDS,
  INSTRUCTION_KINDS,
  LEAD_STATUSES,
  LLM_PROVIDERS,
  LLM_PURPOSES,
  SES_EVENT_TYPES,
  SUPPRESSION_REASONS,
  USER_ROLES,
} from "@mailapp/shared";
import type {
  CampaignAiConfig,
  HardRules,
  ImportSummary,
  MatchedService,
  Persona,
  Sequence,
  ValidationResult,
} from "@mailapp/shared";

export const userRoleEnum = pgEnum("user_role", USER_ROLES);
export const campaignStatusEnum = pgEnum("campaign_status", CAMPAIGN_STATUSES);
export const approvalModeEnum = pgEnum("approval_mode", APPROVAL_MODES);
export const leadStatusEnum = pgEnum("lead_status", LEAD_STATUSES);
export const emailStatusEnum = pgEnum("email_status", EMAIL_STATUSES);
export const emailDirectionEnum = pgEnum("email_direction", EMAIL_DIRECTIONS);
export const sesEventTypeEnum = pgEnum("ses_event_type", SES_EVENT_TYPES);
export const instructionKindEnum = pgEnum("instruction_kind", INSTRUCTION_KINDS);
export const suppressionReasonEnum = pgEnum("suppression_reason", SUPPRESSION_REASONS);
export const fileKindEnum = pgEnum("file_kind", FILE_KINDS);
export const campaignAccessLevelEnum = pgEnum("campaign_access_level", CAMPAIGN_ACCESS_LEVELS);
export const dashboardScopeEnum = pgEnum("dashboard_scope", DASHBOARD_SCOPES);
export const llmProviderEnum = pgEnum("llm_provider", LLM_PROVIDERS);
export const llmPurposeEnum = pgEnum("llm_purpose", LLM_PURPOSES);
export const batchStatusEnum = pgEnum("llm_batch_status", BATCH_STATUSES);
export const batchItemStatusEnum = pgEnum("llm_batch_item_status", BATCH_ITEM_STATUSES);
export const batchStrategyEnum = pgEnum("llm_batch_strategy", BATCH_STRATEGIES);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 254 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("operator"),
  isActive: boolean("is_active").notNull().default(true),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  // Personal sender identity; null falls back to the organisation settings.
  fromEmail: varchar("from_email", { length: 254 }),
  fromName: varchar("from_name", { length: 120 }),
  replyTo: varchar("reply_to", { length: 254 }),
  postalAddress: varchar("postal_address", { length: 300 }),
  dashboardScope: dashboardScopeEnum("dashboard_scope").notNull().default("own"),
  // Personal IMAP mailbox polled for replies (password encrypted with APP_SECRET).
  imapEnabled: boolean("imap_enabled").notNull().default(false),
  imapHost: varchar("imap_host", { length: 253 }),
  imapPort: integer("imap_port").notNull().default(993),
  imapUser: varchar("imap_user", { length: 254 }),
  imapPasswordEnc: text("imap_password_enc"),
  imapMailbox: varchar("imap_mailbox", { length: 200 }).notNull().default("INBOX"),
  ...timestamps,
});

/** Per-mailbox IMAP polling position so no message is processed twice and no flags are touched. */
export const imapCursors = pgTable("imap_cursors", {
  /** "env" for the organisation mailbox from the environment, "user:<id>" for personal ones. */
  accountKey: varchar("account_key", { length: 80 }).primaryKey(),
  uidValidity: text("uid_validity"),
  lastUid: integer("last_uid").notNull().default(0),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Admin-granted access to a campaign for a user who did not create it. */
export const campaignAccess = pgTable(
  "campaign_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    level: campaignAccessLevelEnum("level").notNull().default("view"),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("campaign_access_uq").on(t.campaignId, t.userId), index("campaign_access_user_idx").on(t.userId)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("refresh_tokens_user_idx").on(t.userId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    userEmail: varchar("user_email", { length: 254 }),
    action: varchar("action", { length: 120 }).notNull(),
    entityType: varchar("entity_type", { length: 60 }),
    entityId: varchar("entity_id", { length: 80 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_created_idx").on(t.createdAt), index("audit_logs_entity_idx").on(t.entityType, t.entityId)],
);

export const settings = pgTable("settings", {
  key: varchar("key", { length: 80 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description").notNull(),
  targetAudience: text("target_audience").notNull().default(""),
  valueProps: jsonb("value_props").$type<string[]>().notNull().default([]),
  proofPoints: jsonb("proof_points").$type<string[]>().notNull().default([]),
  url: text("url").notNull().default(""),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
});

export const instructionDocs = pgTable(
  "instruction_docs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: instructionKindEnum("kind").notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    content: text("content").notNull(),
    version: integer("version").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /** null = organisation-wide (admin managed); otherwise a user's personal document. */
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("instruction_docs_kind_idx").on(t.kind, t.isActive), index("instruction_docs_owner_idx").on(t.ownerId)],
);

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: fileKindEnum("kind").notNull(),
  storage: varchar("storage", { length: 10 }).notNull(),
  key: text("key").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: varchar("mime_type", { length: 120 }),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description").notNull().default(""),
    status: campaignStatusEnum("status").notNull().default("draft"),
    approvalMode: approvalModeEnum("approval_mode").notNull().default("manual"),
    sequence: jsonb("sequence").$type<Sequence>().notNull(),
    serviceIds: jsonb("service_ids").$type<string[]>().notNull().default([]),
    fromEmail: varchar("from_email", { length: 254 }),
    fromName: varchar("from_name", { length: 120 }),
    replyTo: varchar("reply_to", { length: 254 }),
    extraGuidance: text("extra_guidance").notNull().default(""),
    hardRulesOverride: jsonb("hard_rules_override").$type<Partial<HardRules>>(),
    /** Only the model/research fields this campaign overrides; null = inherit everything. */
    aiConfig: jsonb("ai_config").$type<CampaignAiConfig>(),
    sourceFileId: uuid("source_file_id").references(() => files.id, { onDelete: "set null" }),
    sourceFileName: text("source_file_name"),
    headerMap: jsonb("header_map").$type<Record<string, string>>(),
    originalHeaders: jsonb("original_headers").$type<string[]>(),
    importSummary: jsonb("import_summary").$type<ImportSummary>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("campaigns_status_idx").on(t.status)],
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    email: varchar("email", { length: 254 }).notNull(),
    firstName: varchar("first_name", { length: 120 }),
    lastName: varchar("last_name", { length: 120 }),
    company: varchar("company", { length: 200 }),
    website: text("website"),
    jobTitle: varchar("job_title", { length: 200 }),
    linkedinUrl: text("linkedin_url"),
    industry: varchar("industry", { length: 120 }),
    location: varchar("location", { length: 200 }),
    phone: varchar("phone", { length: 60 }),
    notes: text("notes"),
    extra: jsonb("extra").$type<Record<string, string>>().notNull().default({}),
    status: leadStatusEnum("status").notNull().default("pending"),
    currentStep: integer("current_step").notNull().default(0),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    persona: jsonb("persona").$type<Persona>(),
    researchRaw: jsonb("research_raw").$type<Record<string, unknown>>(),
    matchedServices: jsonb("matched_services").$type<MatchedService[]>(),
    lastError: text("last_error"),
    /** Rollups in micro-dollars, maintained as calls are recorded. */
    researchCostMicroUsd: integer("research_cost_micro_usd").notNull().default(0),
    totalCostMicroUsd: integer("total_cost_micro_usd").notNull().default(0),
    unsubscribeToken: varchar("unsubscribe_token", { length: 128 }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    complainedAt: timestamp("complained_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("leads_campaign_email_uq").on(t.campaignId, t.email),
    index("leads_status_idx").on(t.status),
    index("leads_next_action_idx").on(t.nextActionAt),
    index("leads_email_idx").on(t.email),
    uniqueIndex("leads_unsub_token_uq").on(t.unsubscribeToken),
  ],
);

export const emails = pgTable(
  "emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    step: integer("step").notNull().default(1),
    direction: emailDirectionEnum("direction").notNull().default("outbound"),
    status: emailStatusEnum("status").notNull().default("draft"),
    fromEmail: varchar("from_email", { length: 254 }),
    toEmail: varchar("to_email", { length: 254 }).notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    sesMessageId: varchar("ses_message_id", { length: 200 }),
    messageIdHeader: varchar("message_id_header", { length: 300 }),
    inReplyTo: varchar("in_reply_to", { length: 300 }),
    referencesHeader: text("references_header"),
    llmMeta: jsonb("llm_meta").$type<Record<string, unknown>>(),
    /** Micro-dollars the drafting of this email cost, including a validator retry. */
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    validation: jsonb("validation").$type<ValidationResult>(),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** The user on whose behalf the email went out (campaign owner at send time). */
    senderUserId: uuid("sender_user_id").references(() => users.id, { onDelete: "set null" }),
    rawSendResponse: jsonb("raw_send_response").$type<Record<string, unknown>>(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    index("emails_lead_idx").on(t.leadId),
    index("emails_campaign_status_idx").on(t.campaignId, t.status),
    index("emails_ses_message_idx").on(t.sesMessageId),
    index("emails_message_id_header_idx").on(t.messageIdHeader),
    index("emails_status_idx").on(t.status),
    index("emails_sender_user_idx").on(t.senderUserId, t.sentAt),
  ],
);

export const sendAttempts = pgTable(
  "send_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailId: uuid("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<Record<string, unknown>>(),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("send_attempts_email_idx").on(t.emailId)],
);

export const emailEvents = pgTable(
  "email_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailId: uuid("email_id").references(() => emails.id, { onDelete: "set null" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    sesMessageId: varchar("ses_message_id", { length: 200 }).notNull(),
    eventType: sesEventTypeEnum("event_type").notNull(),
    subType: varchar("sub_type", { length: 80 }),
    dedupeKey: varchar("dedupe_key", { length: 300 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_events_dedupe_uq").on(t.dedupeKey),
    index("email_events_message_idx").on(t.sesMessageId),
    index("email_events_type_time_idx").on(t.eventType, t.occurredAt),
    index("email_events_campaign_idx").on(t.campaignId),
  ],
);

export const suppressions = pgTable("suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 254 }).notNull().unique(),
  reason: suppressionReasonEnum("reason").notNull(),
  note: text("note"),
  source: varchar("source", { length: 80 }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: varchar("source", { length: 20 }).notNull(), // ses | imap | manual
    externalId: varchar("external_id", { length: 300 }).notNull(),
    fromEmail: varchar("from_email", { length: 254 }),
    toEmail: varchar("to_email", { length: 254 }),
    subject: text("subject"),
    bodyText: text("body_text"),
    messageIdHeader: varchar("message_id_header", { length: 300 }),
    inReplyTo: varchar("in_reply_to", { length: 300 }),
    referencesHeader: text("references_header"),
    matchedLeadId: uuid("matched_lead_id").references(() => leads.id, { onDelete: "set null" }),
    matchedEmailId: uuid("matched_email_id").references(() => emails.id, { onDelete: "set null" }),
    matchMethod: varchar("match_method", { length: 40 }),
    isAutoReply: boolean("is_auto_reply").notNull().default(false),
    rawFileId: uuid("raw_file_id").references(() => files.id, { onDelete: "set null" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("inbound_messages_external_uq").on(t.source, t.externalId)],
);

export const sesSnapshots = pgTable("ses_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: varchar("kind", { length: 40 }).notNull(), // account | metrics
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dailySendCounters = pgTable("daily_send_counters", {
  day: varchar("day", { length: 10 }).primaryKey(), // YYYY-MM-DD (UTC)
  count: integer("count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    emailId: uuid("email_id").references(() => emails.id, { onDelete: "set null" }),
    purpose: varchar("purpose", { length: 40 }).notNull(), // research | persona | draft
    provider: llmProviderEnum("provider").notNull().default("anthropic"),
    /** Catalogue key ("anthropic:claude-opus-5-5"); `model` keeps the raw provider id. */
    modelKey: varchar("model_key", { length: 120 }).notNull().default(""),
    model: varchar("model", { length: 80 }).notNull(),
    /** Went through the provider's batch endpoint, so discounted rates applied. */
    batch: boolean("batch").notNull().default(false),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /**
     * Cost charged for this call, in micro-dollars, priced at the moment of the call.
     * Stored rather than derived so a later rate change never rewrites history.
     */
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    stopReason: varchar("stop_reason", { length: 40 }),
    ok: boolean("ok").notNull().default(true),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("llm_calls_created_idx").on(t.createdAt),
    index("llm_calls_campaign_idx").on(t.campaignId, t.purpose),
    index("llm_calls_lead_idx").on(t.leadId),
    index("llm_calls_model_idx").on(t.modelKey),
  ],
);

/** An API key for a model provider, supplied from the dashboard instead of the environment. */
export const providerCredentials = pgTable("provider_credentials", {
  provider: llmProviderEnum("provider").primaryKey(),
  /** Encrypted with APP_SECRET (AES-256-GCM), like IMAP passwords. */
  apiKeyEnc: text("api_key_enc").notNull(),
  /** Last four characters, kept in clear so the UI can show which key is stored. */
  keyHint: varchar("key_hint", { length: 8 }).notNull().default(""),
  baseUrl: text("base_url"),
  lastTestOk: boolean("last_test_ok"),
  lastTestAt: timestamp("last_test_at", { withTimezone: true }),
  lastTestMessage: text("last_test_message"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One submission to a provider's batch endpoint. Rows start as `pending` with no external
 * id: the batch tick groups pending items, submits them, then polls until results land.
 */
export const llmBatches = pgTable(
  "llm_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    provider: llmProviderEnum("provider").notNull(),
    modelKey: varchar("model_key", { length: 120 }).notNull(),
    model: varchar("model", { length: 80 }).notNull(),
    purpose: llmPurposeEnum("purpose").notNull(),
    strategy: batchStrategyEnum("strategy").notNull().default("rolling"),
    status: batchStatusEnum("status").notNull().default("pending"),
    /** The provider's own batch id, once submitted. */
    externalId: varchar("external_id", { length: 200 }),
    /** Provider-specific handles (OpenAI input/output file ids, Gemini job name). */
    externalMeta: jsonb("external_meta").$type<Record<string, unknown>>(),
    requestCount: integer("request_count").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    errored: integer("errored").notNull().default(0),
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    pollAttempts: integer("poll_attempts").notNull().default(0),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    index("llm_batches_status_idx").on(t.status),
    index("llm_batches_campaign_idx").on(t.campaignId),
    uniqueIndex("llm_batches_external_uq").on(t.provider, t.externalId),
  ],
);

/**
 * One request inside a batch. `payload` holds the fully built provider request so a batch
 * can be resubmitted after an expiry without re-running the prompt assembly.
 */
export const llmBatchItems = pgTable(
  "llm_batch_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").references(() => llmBatches.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    /** Unique within a batch; also the provider's custom_id. */
    customId: varchar("custom_id", { length: 120 }).notNull(),
    purpose: llmPurposeEnum("purpose").notNull(),
    provider: llmProviderEnum("provider").notNull(),
    modelKey: varchar("model_key", { length: 120 }).notNull(),
    model: varchar("model", { length: 80 }).notNull(),
    /** Sequence step for draft items; 0 for research (not null, so the dedupe index bites). */
    step: integer("step").notNull().default(0),
    /** 1, or 2 when this is the validator-feedback retry of a failed draft. */
    attempt: integer("attempt").notNull().default(1),
    status: batchItemStatusEnum("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Extra context needed to apply the result (regenerate target, validator feedback). */
    context: jsonb("context").$type<Record<string, unknown>>(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    error: text("error"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // The flush query: pending items grouped by what they would be submitted as.
    index("llm_batch_items_pending_idx").on(t.status, t.campaignId, t.purpose, t.modelKey, t.queuedAt),
    index("llm_batch_items_batch_idx").on(t.batchId),
    index("llm_batch_items_lead_idx").on(t.leadId),
    // One in-flight request per lead/purpose/step/attempt, so retried jobs cannot double-charge.
    uniqueIndex("llm_batch_items_dedupe_uq").on(t.leadId, t.purpose, t.step, t.attempt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type CampaignAccessRow = typeof campaignAccess.$inferSelect;
export type CampaignRow = typeof campaigns.$inferSelect;
export type LeadRow = typeof leads.$inferSelect;
export type EmailRow = typeof emails.$inferSelect;
export type ServiceRow = typeof services.$inferSelect;
export type InstructionRow = typeof instructionDocs.$inferSelect;
export type EmailEventRow = typeof emailEvents.$inferSelect;
export type SuppressionRow = typeof suppressions.$inferSelect;
export type SendAttemptRow = typeof sendAttempts.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type InboundMessageRow = typeof inboundMessages.$inferSelect;
export type LlmCallRow = typeof llmCalls.$inferSelect;
export type ProviderCredentialRow = typeof providerCredentials.$inferSelect;
export type LlmBatchRow = typeof llmBatches.$inferSelect;
export type LlmBatchItemRow = typeof llmBatchItems.$inferSelect;
export type RealType = typeof real;
