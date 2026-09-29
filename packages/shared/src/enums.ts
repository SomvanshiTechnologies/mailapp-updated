export const USER_ROLES = ["admin", "operator", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const CAMPAIGN_STATUSES = [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const APPROVAL_MODES = ["manual", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * Lead lifecycle. Terminal states: replied, bounced, complained, unsubscribed,
 * suppressed, invalid, rejected, completed, failed (failed can be retried).
 */
export const LEAD_STATUSES = [
  "pending",
  "researching",
  "researched",
  "drafting",
  "pending_review",
  "approved",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "replied",
  "bounced",
  "complained",
  "unsubscribed",
  "suppressed",
  "invalid",
  "rejected",
  "failed",
  "completed",
  "skipped",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const TERMINAL_LEAD_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>([
  "replied",
  "bounced",
  "complained",
  "unsubscribed",
  "suppressed",
  "invalid",
  "rejected",
  "completed",
  "skipped",
]);

/** Statuses in which a lead is eligible for a follow-up step. */
export const FOLLOWUP_ELIGIBLE_LEAD_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>([
  "sent",
  "delivered",
  "opened",
  "clicked",
]);

export const EMAIL_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "queued",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const EMAIL_DIRECTIONS = ["outbound", "inbound"] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];

/** SES event types as delivered by a configuration-set event destination. */
export const SES_EVENT_TYPES = [
  "Send",
  "Delivery",
  "Bounce",
  "Complaint",
  "Reject",
  "Open",
  "Click",
  "RenderingFailure",
  "DeliveryDelay",
  "Subscription",
] as const;
export type SesEventType = (typeof SES_EVENT_TYPES)[number];

export const INSTRUCTION_KINDS = [
  "company_profile",
  "tone",
  "format",
  "rules",
  "signature",
  "followup_guidance",
  "other",
] as const;
export type InstructionKind = (typeof INSTRUCTION_KINDS)[number];

export const SUPPRESSION_REASONS = [
  "hard_bounce",
  "complaint",
  "unsubscribe",
  "manual",
  "ses_account_list",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const FILE_KINDS = [
  "leads_upload",
  "services_upload",
  "instruction_upload",
  "suppression_upload",
  "export",
  "inbound_raw",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const JOB_QUEUES = {
  research: "lead.research",
  draft: "lead.draft",
  send: "email.send",
  followupTick: "followup.tick",
  sesSync: "ses.sync",
  metricsFlush: "metrics.flush",
  imapPoll: "imap.poll",
  export: "campaign.export",
  /** Flushes queued batch requests and polls open provider batches. */
  llmBatchTick: "llm.batch.tick",
} as const;
export type JobQueue = (typeof JOB_QUEUES)[keyof typeof JOB_QUEUES];

/** Per-campaign access granted by an admin to a non-owner. */
export const CAMPAIGN_ACCESS_LEVELS = ["view", "edit", "full"] as const;
export type CampaignAccessLevel = (typeof CAMPAIGN_ACCESS_LEVELS)[number];

/**
 * How outbound mail is shaped for the inbox classifier.
 * personal: looks like a hand-written one-to-one email (no List-Unsubscribe headers, no styled footer).
 * bulk: classic newsletter shape (List-Unsubscribe headers, styled HTML, compliance footer).
 */
export const DELIVERY_MODES = ["personal", "bulk"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** Which campaigns a non-admin sees on the dashboard: only their own/granted ones, or every campaign. */
export const DASHBOARD_SCOPES = ["own", "all"] as const;
export type DashboardScope = (typeof DASHBOARD_SCOPES)[number];
