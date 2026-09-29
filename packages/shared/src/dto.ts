import type {
  ApprovalMode,
  CampaignAccessLevel,
  CampaignStatus,
  DashboardScope,
  EmailDirection,
  EmailStatus,
  InstructionKind,
  LeadStatus,
  SesEventType,
  SuppressionReason,
  UserRole,
} from "./enums.js";
import type { Persona } from "./llm-schemas.js";
import type { CampaignAiConfig, HardRules, Sequence, Settings } from "./schemas.js";
import type {
  BatchItemStatus,
  BatchStatus,
  BatchStrategy,
  ConfigurableProvider,
  LlmProviderName,
  LlmPurpose,
  ModelRates,
  ResearchMode,
} from "./models.js";
import type { CostEstimate } from "./cost.js";

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /** Personal sender identity; null = organisation default applies. */
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  postalAddress: string | null;
  dashboardScope: DashboardScope;
  /** Reply polling of the user's own mailbox (password never returned). */
  imap: {
    enabled: boolean;
    host: string | null;
    port: number;
    user: string | null;
    mailbox: string;
    passwordSet: boolean;
    lastPolledAt: string | null;
    lastError: string | null;
  };
  /** The Reply-To address campaigns of this user will carry, after all fallbacks. */
  effectiveReplyTo: string;
}

/** Per-user sending activity (admin view). */
export interface UserStatsDto {
  userId: string;
  campaigns: number;
  activeCampaigns: number;
  sentTotal: number;
  sentLast7Days: number;
  sentToday: number;
  /** Approved/queued emails that have not gone out yet. */
  pendingSend: number;
  lastSentAt: string | null;
}

export interface CampaignAccessDto {
  userId: string;
  userName: string;
  userEmail: string;
  level: CampaignAccessLevel;
  grantedBy: string | null;
  createdAt: string;
}

export interface ServiceDto {
  id: string;
  name: string;
  description: string;
  targetAudience: string;
  valueProps: string[];
  proofPoints: string[];
  url: string;
  tags: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InstructionDto {
  id: string;
  kind: InstructionKind;
  title: string;
  content: string;
  version: number;
  isActive: boolean;
  createdBy: string | null;
  /** null = organisation-wide document; otherwise the owning user's id. */
  ownerId: string | null;
  createdAt: string;
}

export interface CampaignCounts {
  total: number;
  pending: number;
  researching: number;
  drafting: number;
  pendingReview: number;
  approved: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  failed: number;
  other: number;
}

/** Money and tokens already spent on a campaign, plus the derived per-unit figures. */
export interface CostSummary {
  /** Integer micro-dollars (1e-6 USD); use formatUsd() to display. */
  totalMicroUsd: number;
  researchMicroUsd: number;
  draftMicroUsd: number;
  perLeadMicroUsd: number;
  perEmailMicroUsd: number;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Leads and emails the per-unit figures were divided by. */
  leads: number;
  emails: number;
  /** Share of spend that went through a batch endpoint, 0-100. */
  batchSharePct: number;
}

/** Spend grouped by the model that produced it, for the cost breakdown table. */
export interface CostByModel {
  modelKey: string;
  provider: LlmProviderName;
  label: string;
  batch: boolean;
  purpose: LlmPurpose | "all";
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  microUsd: number;
}

/** The models a campaign will actually use, after inheritance is applied. */
export interface ResolvedAiConfig {
  researchModel: string;
  researchModelLabel: string;
  researchBatch: boolean;
  draftModel: string;
  draftModelLabel: string;
  draftBatch: boolean;
  researchMode: ResearchMode;
  batchStrategy: BatchStrategy;
  /** Which of the above came from the campaign rather than the organisation settings. */
  overridden: Array<keyof CampaignAiConfig>;
  /** True when either model routes through a batch endpoint. */
  usesBatch: boolean;
}

export interface CampaignCostDto {
  actual: CostSummary;
  estimate: CostEstimate;
  byModel: CostByModel[];
  ai: ResolvedAiConfig;
  /** Open batches for this campaign, so the UI can explain why drafts have not appeared. */
  batches: BatchDto[];
}

export interface BatchDto {
  id: string;
  provider: LlmProviderName;
  model: string;
  purpose: LlmPurpose;
  campaignId: string | null;
  campaignName: string | null;
  externalId: string | null;
  status: BatchStatus;
  strategy: BatchStrategy;
  requestCount: number;
  succeeded: number;
  errored: number;
  microUsd: number;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  lastPolledAt: string | null;
  error: string | null;
}

export interface BatchItemDto {
  id: string;
  customId: string;
  leadId: string | null;
  step: number | null;
  attempt: number;
  status: BatchItemStatus;
  microUsd: number;
  error: string | null;
}

/** One provider's configuration state, for the Settings "API keys" card. */
export interface ProviderStatusDto {
  provider: ConfigurableProvider;
  label: string;
  /** A usable key exists (from either source). */
  configured: boolean;
  source: "database" | "environment" | "none";
  baseUrl: string | null;
  envVar: string;
  keysUrl: string;
  /** Last four characters of the stored key, for recognition. Null when it came from env. */
  keyHint: string | null;
  updatedAt: string | null;
  /** Models in the catalogue that need this provider. */
  modelCount: number;
  /** Result of the last connectivity test run from the dashboard. */
  lastTest: { ok: boolean; at: string; message: string | null } | null;
}

/** One catalogue entry as the picker needs it, with rates after any admin override. */
export interface ModelOptionDto {
  value: string;
  modelKey: string;
  provider: LlmProviderName;
  providerLabel: string;
  model: string;
  label: string;
  note: string;
  batch: boolean;
  available: boolean;
  tier: "flagship" | "balanced" | "fast";
  webSearch: boolean;
  effort: boolean;
  contextWindow: number;
  rates: ModelRates;
  rateOverridden: boolean;
  /** Indicative cost of researching one lead and drafting one email with this model. */
  indicative: { researchMicroUsd: number; draftMicroUsd: number };
}

export interface CampaignDto {
  id: string;
  name: string;
  description: string;
  status: CampaignStatus;
  approvalMode: ApprovalMode;
  sequence: Sequence;
  serviceIds: string[];
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  extraGuidance: string;
  hardRulesOverride: Partial<HardRules> | null;
  /** Only the fields this campaign deliberately overrides; null when it inherits everything. */
  aiConfig: CampaignAiConfig | null;
  /** The effective configuration after inheritance. */
  ai: ResolvedAiConfig;
  /** Spend to date on this campaign. */
  cost: CostSummary;
  sourceFileName: string | null;
  headerMap: Record<string, string> | null;
  importSummary: ImportSummary | null;
  counts: CampaignCounts;
  createdBy: string | null;
  createdByName: string | null;
  /** The caller's effective access to this campaign. */
  myAccess: CampaignAccessLevel;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ImportSummary {
  totalRows: number;
  imported: number;
  duplicatesInSheet: number;
  invalidEmails: number;
  suppressed: number;
  missingRequired: string[];
  unmappedColumns: string[];
  sampleErrors: Array<{ row: number; reason: string }>;
}

export interface MatchedService {
  serviceId: string;
  serviceName: string;
  fitScore: number;
  rationale: string;
}

export interface LeadDto {
  id: string;
  campaignId: string;
  rowNumber: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  website: string | null;
  jobTitle: string | null;
  linkedinUrl: string | null;
  industry: string | null;
  location: string | null;
  phone: string | null;
  notes: string | null;
  extra: Record<string, string>;
  status: LeadStatus;
  currentStep: number;
  nextActionAt: string | null;
  /** When the next approved/queued email for this lead is expected to go out (null if none). */
  nextSendAt: string | null;
  persona: Persona | null;
  matchedServices: MatchedService[] | null;
  lastError: string | null;
  /** Micro-dollars spent researching this lead. */
  researchMicroUsd: number;
  /** Micro-dollars spent on this lead in total (research plus every draft). */
  totalMicroUsd: number;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  repliedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailDto {
  id: string;
  leadId: string;
  campaignId: string;
  step: number;
  direction: EmailDirection;
  status: EmailStatus;
  fromEmail: string | null;
  toEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  sesMessageId: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  llmMeta: Record<string, unknown> | null;
  /** Micro-dollars the draft of this email cost, including a validator retry. */
  costMicroUsd: number;
  validation: ValidationResult | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Set when the send was deferred (send window / daily cap). */
  scheduledFor: string | null;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  rule: string;
  severity: "error" | "warning";
  message: string;
}
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  wordCount: number;
  linkCount: number;
}

export interface EmailEventDto {
  id: string;
  emailId: string | null;
  leadId: string | null;
  sesMessageId: string;
  eventType: SesEventType;
  subType: string | null;
  occurredAt: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

export interface SendAttemptDto {
  id: string;
  emailId: string;
  attemptNo: number;
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  durationMs: number;
  createdAt: string;
}

export interface LeadDetailDto extends LeadDto {
  emails: EmailDto[];
  events: EmailEventDto[];
  attempts: SendAttemptDto[];
}

export interface SuppressionDto {
  id: string;
  email: string;
  reason: SuppressionReason;
  note: string | null;
  source: string | null;
  createdAt: string;
}

/** Distinct values present in the audit log, for filter drop-downs. */
export interface AuditFacets {
  actions: string[];
  entityTypes: string[];
  users: string[];
}

export interface AuditLogDto {
  id: string;
  userId: string | null;
  userEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface OverviewAnalytics {
  range: { from: string; to: string };
  totals: {
    leads: number;
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    opened: number;
    clicked: number;
    replied: number;
    unsubscribed: number;
    failed: number;
    pendingReview: number;
  };
  rates: {
    deliveryRate: number;
    bounceRate: number;
    complaintRate: number;
    openRate: number;
    clickRate: number;
    replyRate: number;
  };
  byCampaign: Array<{
    campaignId: string;
    name: string;
    status: CampaignStatus;
    sent: number;
    delivered: number;
    opened: number;
    replied: number;
    bounced: number;
  }>;
}

export interface TimeseriesPoint {
  date: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  replied: number;
}

export interface SesAccountInfo {
  fetchedAt: string;
  mode: "ses" | "mock";
  region: string;
  sendingEnabled: boolean;
  productionAccessEnabled: boolean;
  enforcementStatus: string | null;
  sendQuota: { max24HourSend: number; maxSendRate: number; sentLast24Hours: number } | null;
  dedicatedIpAutoWarmupEnabled: boolean | null;
  vdmEnabled: boolean | null;
  suppressionReasons: string[];
  details: string | null;
  error: string | null;
}

export interface SesCloudWatchSeries {
  metric: string;
  points: Array<{ timestamp: string; value: number }>;
}

export interface SesMetricsResponse {
  fetchedAt: string;
  enabled: boolean;
  configurationSet: string | null;
  period: number;
  series: SesCloudWatchSeries[];
  error: string | null;
}

export interface QueueStat {
  queue: string;
  created: number;
  active: number;
  completed: number;
  failed: number;
  retry: number;
}

export interface SystemStatus {
  now: string;
  version: string;
  env: string;
  llmProvider: string;
  sesMode: string;
  db: "ok" | "error";
  queue: "ok" | "error";
  queues: QueueStat[];
  lastSesSyncAt: string | null;
  sentToday: number;
  dailyCap: number;
  /** How replies reach the app. */
  replyCapture: {
    /** SES receives mail for this domain and posts it to the app; null when not configured. */
    inboundDomain: string | null;
    /** Mailboxes the worker polls over IMAP (organisation mailbox from env + users' own). */
    imapAccounts: Array<{ key: string; label: string; enabled: boolean; lastPolledAt: string | null; lastError: string | null }>;
  };
}

export interface SettingsDto extends Settings {
  updatedAt: string | null;
}

/** Organisation-wide LLM usage and spend for the dashboard. */
export interface LlmUsageDto {
  range: { from: string; to: string };
  calls: number;
  failures: number;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalMicroUsd: number;
  /** Cost per email actually sent in the range — the number that matters commercially. */
  microUsdPerSentEmail: number;
  microUsdPerLead: number;
  byModel: CostByModel[];
  byPurpose: Array<{ purpose: LlmPurpose; calls: number; microUsd: number }>;
  /** Daily spend, for the cost chart. */
  daily: Array<{ date: string; microUsd: number; calls: number }>;
}
