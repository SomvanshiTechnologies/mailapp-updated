import type { DraftOutput, HardRules, Persona, SequenceStep } from "@mailapp/shared";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import type { Logger } from "../../observability/logger.js";
import type { MetricsSink } from "../../observability/metrics.js";
import type { LeadRow, ServiceRow } from "../../db/schema.js";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResult<T> {
  output: T;
  model: string;
  usage: LlmUsage;
  durationMs: number;
  stopReason: string | null;
  /** Free-text research findings / rationale kept for the dashboard. */
  notes?: string;
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
  model: string;
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
  model: string;
}

export interface LlmProvider {
  readonly name: "anthropic" | "mock";
  research(input: ResearchInput): Promise<LlmResult<Persona>>;
  draft(input: DraftInput): Promise<LlmResult<DraftOutput>>;
}

export interface LlmDeps {
  config: AppConfig;
  logger: Logger;
  metrics: MetricsSink;
  db: Db;
}

export function createLlmProvider(config: AppConfig, logger: Logger, metrics: MetricsSink, db: Db): LlmProvider {
  const deps: LlmDeps = { config, logger, metrics, db };
  if (config.LLM_PROVIDER === "anthropic") {
    // Lazy import keeps the SDK out of the test path when mocked.
    const { AnthropicProvider } = requireAnthropic();
    return new AnthropicProvider(deps);
  }
  const { MockLlmProvider } = requireMock();
  return new MockLlmProvider(deps);
}

// Static imports would create a cycle for tests that stub providers; use sync requires via ESM-friendly pattern.
import { AnthropicProvider as _AnthropicProvider } from "./anthropic.js";
import { MockLlmProvider as _MockLlmProvider } from "./mock.js";
function requireAnthropic() {
  return { AnthropicProvider: _AnthropicProvider };
}
function requireMock() {
  return { MockLlmProvider: _MockLlmProvider };
}
