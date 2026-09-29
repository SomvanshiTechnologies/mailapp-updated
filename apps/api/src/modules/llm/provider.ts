import type { DraftOutput, HardRules, LlmPurpose, Persona, ResearchMode, ResearchModeProfile, SequenceStep, TokenUsage } from "@mailapp/shared";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import type { Logger } from "../../observability/logger.js";
import type { MetricsSink } from "../../observability/metrics.js";
import type { LeadRow, ServiceRow } from "../../db/schema.js";
import type { ResolvedModel } from "./catalogue.js";
import type { ProviderCredentialStore } from "./credentials.js";

/** Kept as an alias so existing call sites and stored JSON keep the same shape. */
export type LlmUsage = TokenUsage;

export interface LlmResult<T> {
  output: T;
  model: string;
  usage: LlmUsage;
  durationMs: number;
  stopReason: string | null;
  /** Free-text research findings / rationale kept for the dashboard. */
  notes?: string;
  /** What the call cost, in micro-dollars, once recorded. */
  costMicroUsd?: number;
}

export interface WebsiteExtract {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
  fetchedAt: string;
}

export interface InstructionBundle {
  companyProfile: string;
  tone: string;
  format: string;
  rules: string;
  signature: string;
  followupGuidance: string;
  other: string;
}

export interface ResearchInput {
  lead: LeadRow;
  website: WebsiteExtract | null;
  companyProfile: string;
  serviceSummaries: string[];
  /** The resolved model, including rates and batch flag. */
  model: ResolvedModel;
  /** Research intensity: effort, tool budgets and iteration cap. */
  profile: ResearchModeProfile;
  researchMode: ResearchMode;
  webSearch: boolean;
}

export interface PreviousEmail {
  step: number;
  subject: string;
  bodyText: string;
  sentAt: string | null;
  direction: "outbound" | "inbound";
}

export interface DraftInput {
  lead: LeadRow;
  persona: Persona;
  services: ServiceRow[];
  instructions: InstructionBundle;
  hardRules: HardRules;
  step: SequenceStep;
  totalSteps: number;
  previousEmails: PreviousEmail[];
  campaignGuidance: string;
  regenerationFeedback: string | null;
  senderName: string;
  model: ResolvedModel;
}

/**
 * A provider-shaped request that can be executed now or submitted to a batch endpoint.
 * `body` is the provider's own request object; the batch layer stores it verbatim so a
 * batch can be resubmitted without reassembling the prompt.
 */
export interface PreparedRequest {
  purpose: LlmPurpose;
  model: ResolvedModel;
  body: Record<string, unknown>;
}

/**
 * Every adapter implements the two synchronous calls plus, optionally, the batch hooks.
 * The router picks the adapter from the resolved model's provider.
 */
export interface LlmAdapter {
  readonly provider: "anthropic" | "openai" | "gemini" | "deepseek" | "mock";
  research(input: ResearchInput): Promise<LlmResult<Persona>>;
  draft(input: DraftInput): Promise<LlmResult<DraftOutput>>;
  /** Build the request a batch item will carry. Only needed when the provider batches. */
  prepareResearch?(input: ResearchInput): PreparedRequest;
  prepareDraft?(input: DraftInput): PreparedRequest;
  /** Cheap call used by the "test key" button. Throws on a bad key. */
  ping?(): Promise<void>;
}

/** Public surface the pipeline uses; the router implements it. */
export interface LlmProvider {
  readonly name: string;
  research(input: ResearchInput): Promise<LlmResult<Persona>>;
  draft(input: DraftInput): Promise<LlmResult<DraftOutput>>;
  /** Adapter for a provider, or null when no key is configured. */
  adapterFor(provider: string): Promise<LlmAdapter | null>;
}

export interface LlmDeps {
  config: AppConfig;
  logger: Logger;
  metrics: MetricsSink;
  db: Db;
  credentials: ProviderCredentialStore;
}

/** Shared concurrency gate so one process cannot flood a provider. */
export class ConcurrencyGate {
  private inflight = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.inflight >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inflight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inflight--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
