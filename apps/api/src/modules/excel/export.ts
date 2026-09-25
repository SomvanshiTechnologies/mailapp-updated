import ExcelJS from "exceljs";
import { EXPORT_STATUS_COLUMNS, LEAD_COLUMN_KEYS, type SettingsDto } from "@mailapp/shared";
import type { CampaignRow, EmailRow, InstructionRow, LeadRow, ServiceRow, SuppressionRow } from "../../db/schema.js";

function bufferOf(wb: ExcelJS.Workbook): Promise<Buffer> {
  return wb.xlsx.writeBuffer().then((out) => Buffer.from(out as ArrayBuffer));
}

function newWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Outreach Engine";
  wb.created = new Date();
  return wb;
}

function headerRow(ws: ExcelJS.Worksheet): void {
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

/** Suppression list as a shareable sheet (re-importable through the Suppressions page). */
export async function buildSuppressionsWorkbook(rows: SuppressionRow[]): Promise<Buffer> {
  const wb = newWorkbook();
  const ws = wb.addWorksheet("Suppressions");
  ws.columns = [
    { header: "email", key: "email", width: 40 },
    { header: "reason", key: "reason", width: 18 },
    { header: "source", key: "source", width: 24 },
    { header: "note", key: "note", width: 50 },
    { header: "created_at", key: "created_at", width: 24 },
  ];
  headerRow(ws);
  for (const s of rows) ws.addRow({ email: s.email, reason: s.reason, source: s.source ?? "", note: s.note ?? "", created_at: s.createdAt.toISOString() });
  return bufferOf(wb);
}

export interface SettingsExportInput {
  settings: SettingsDto;
  /** Organisation docs plus the exporting user's personal docs. */
  instructions: InstructionRow[];
  services: ServiceRow[];
  exportedBy: string;
}

/**
 * Everything a user needs to hand their configuration to someone else: organisation settings
 * and hard rules (key/value), instruction documents (re-importable) and the service catalogue.
 */
export async function buildSettingsWorkbook(input: SettingsExportInput): Promise<Buffer> {
  const wb = newWorkbook();
  const { hardRules, ...general } = input.settings;

  const settingsWs = wb.addWorksheet("Settings");
  settingsWs.columns = [
    { header: "key", key: "k", width: 28 },
    { header: "value", key: "v", width: 60 },
  ];
  headerRow(settingsWs);
  settingsWs.addRow({ k: "exported_at", v: new Date().toISOString() });
  settingsWs.addRow({ k: "exported_by", v: input.exportedBy });
  for (const [k, v] of Object.entries(general)) settingsWs.addRow({ k, v: v === null || v === undefined ? "" : String(v) });

  const rulesWs = wb.addWorksheet("HardRules");
  rulesWs.columns = [
    { header: "key", key: "k", width: 28 },
    { header: "value", key: "v", width: 60 },
  ];
  headerRow(rulesWs);
  for (const [k, v] of Object.entries(hardRules)) rulesWs.addRow({ k, v: Array.isArray(v) ? v.join("; ") : String(v) });

  const docsWs = wb.addWorksheet("Instructions");
  docsWs.columns = [
    { header: "scope", key: "scope", width: 14 },
    { header: "kind", key: "kind", width: 20 },
    { header: "title", key: "title", width: 32 },
    { header: "version", key: "version", width: 10 },
    { header: "active", key: "active", width: 10 },
    { header: "content", key: "content", width: 100 },
  ];
  headerRow(docsWs);
  for (const d of input.instructions) {
    docsWs.addRow({ scope: d.ownerId ? "personal" : "organisation", kind: d.kind, title: d.title, version: d.version, active: d.isActive ? "yes" : "no", content: d.content });
  }

  const svcWs = wb.addWorksheet("Services");
  svcWs.columns = [
    { header: "name", key: "name", width: 30 },
    { header: "description", key: "description", width: 80 },
    { header: "target_audience", key: "target_audience", width: 40 },
    { header: "value_props", key: "value_props", width: 50 },
    { header: "proof_points", key: "proof_points", width: 50 },
    { header: "url", key: "url", width: 40 },
    { header: "tags", key: "tags", width: 30 },
    { header: "active", key: "active", width: 10 },
  ];
  headerRow(svcWs);
  for (const s of input.services) {
    svcWs.addRow({
      name: s.name,
      description: s.description,
      target_audience: s.targetAudience,
      value_props: s.valueProps.join("; "),
      proof_points: s.proofPoints.join("; "),
      url: s.url,
      tags: s.tags.join("; "),
      active: s.isActive ? "yes" : "no",
    });
  }
  return bufferOf(wb);
}

const LEAD_FIELD_BY_KEY: Record<string, (l: LeadRow) => string | null> = {
  email: (l) => l.email,
  first_name: (l) => l.firstName,
  last_name: (l) => l.lastName,
  company: (l) => l.company,
  website: (l) => l.website,
  job_title: (l) => l.jobTitle,
  linkedin_url: (l) => l.linkedinUrl,
  industry: (l) => l.industry,
  location: (l) => l.location,
  phone: (l) => l.phone,
  notes: (l) => l.notes,
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");

/**
 * Build the status workbook: the original columns (in the uploaded order, using the uploaded
 * header names) followed by the status columns. Returns the xlsx as a Buffer.
 */
export async function buildStatusWorkbook(
  campaign: CampaignRow,
  leads: LeadRow[],
  latestEmailByLead: Map<string, EmailRow>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Outreach Engine";
  wb.created = new Date();
  const ws = wb.addWorksheet("Status");

  const originalHeaders = campaign.originalHeaders?.length
    ? campaign.originalHeaders
    : LEAD_COLUMN_KEYS.filter((k) => leads.some((l) => LEAD_FIELD_BY_KEY[k]?.(l)));
  const headerMap = campaign.headerMap ?? {};

  const columns = [...originalHeaders, ...EXPORT_STATUS_COLUMNS];
  ws.columns = columns.map((h) => ({ header: h, key: h, width: Math.min(40, Math.max(12, h.length + 2)) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (const lead of leads) {
    const row: Record<string, string | number> = {};
    for (const h of originalHeaders) {
      const key = headerMap[h];
      row[h] = key ? (LEAD_FIELD_BY_KEY[key]?.(lead) ?? "") : (lead.extra?.[h] ?? "");
    }
    const email = latestEmailByLead.get(lead.id);
    row.status = lead.status;
    row.current_step = lead.currentStep;
    row.matched_services = (lead.matchedServices ?? []).map((m) => `${m.serviceName} (${m.fitScore})`).join("; ");
    row.subject = email?.subject ?? "";
    row.ses_message_id = email?.sesMessageId ?? "";
    row.sent_at = iso(lead.sentAt);
    row.delivered_at = iso(lead.deliveredAt);
    row.opened_at = iso(lead.openedAt);
    row.clicked_at = iso(lead.clickedAt);
    row.replied_at = iso(lead.repliedAt);
    row.bounced_at = iso(lead.bouncedAt);
    row.complained_at = iso(lead.complainedAt);
    row.unsubscribed_at = iso(lead.unsubscribedAt);
    row.last_error = lead.lastError ?? "";
    row.last_updated_at = iso(lead.updatedAt);
    ws.addRow(row);
  }

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "k", width: 24 },
    { header: "Value", key: "v", width: 16 },
  ];
  const count = (pred: (l: LeadRow) => boolean) => leads.filter(pred).length;
  const rows: Array<[string, string | number]> = [
    ["Campaign", campaign.name],
    ["Exported at", new Date().toISOString()],
    ["Leads", leads.length],
    ["Sent", count((l) => !!l.sentAt)],
    ["Delivered", count((l) => !!l.deliveredAt)],
    ["Opened", count((l) => !!l.openedAt)],
    ["Clicked", count((l) => !!l.clickedAt)],
    ["Replied", count((l) => !!l.repliedAt)],
    ["Bounced", count((l) => !!l.bouncedAt)],
    ["Complained", count((l) => !!l.complainedAt)],
    ["Unsubscribed", count((l) => !!l.unsubscribedAt)],
  ];
  for (const [k, v] of rows) summary.addRow({ k, v });
  summary.getRow(1).font = { bold: true };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
