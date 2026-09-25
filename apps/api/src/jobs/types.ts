export interface ResearchJob {
  leadId: string;
}

export interface DraftJob {
  leadId: string;
  step: number;
  /** Set when a reviewer asked for a regeneration of an existing draft. */
  regenerate?: { emailId: string; feedback: string | null };
}

export interface SendJob {
  emailId: string;
}

export interface ExportJob {
  campaignId: string;
  userId: string | null;
}

export type TickJob = Record<string, never>;
