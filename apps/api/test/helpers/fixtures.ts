import ExcelJS from "exceljs";
import FormData from "form-data";
import type { TestContext, Session } from "./context.js";
import { req, json } from "./context.js";

export async function xlsxBuffer(headers: string[], rows: Array<Array<string | number | null>>, sheetName = "Leads"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

export const LEAD_HEADERS = ["First Name", "Last Name", "Email", "Company", "Website", "Job Title", "Industry", "Notes", "Account Owner"];

export function leadRows(n = 3, opts: { notes?: string } = {}): Array<Array<string | number | null>> {
  return Array.from({ length: n }, (_, i) => [
    `Lead${i + 1}`,
    "Person",
    `lead${i + 1}@gmail.com`,
    `Company ${i + 1}`,
    "",
    "Head of Operations",
    "Logistics",
    opts.notes ?? "",
    "owner@ours.com",
  ]);
}

export interface MultipartArgs {
  file: { buffer: Buffer; filename: string; contentType?: string };
  fields?: Record<string, string>;
}

export function multipart(args: MultipartArgs): { payload: Buffer; headers: Record<string, string> } {
  const form = new FormData();
  for (const [k, v] of Object.entries(args.fields ?? {})) form.append(k, v);
  form.append("file", args.file.buffer, { filename: args.file.filename, contentType: args.file.contentType ?? "application/octet-stream" });
  return { payload: form.getBuffer(), headers: form.getHeaders() as Record<string, string> };
}

export async function createCampaign(
  ctx: TestContext,
  session: Session,
  opts: { rows?: Array<Array<string | number | null>>; headers?: string[]; payload?: Record<string, unknown> } = {},
) {
  const buffer = await xlsxBuffer(opts.headers ?? LEAD_HEADERS, opts.rows ?? leadRows());
  const mp = multipart({
    file: { buffer, filename: "leads.xlsx" },
    fields: { payload: JSON.stringify({ name: "Test campaign", ...(opts.payload ?? {}) }) },
  });
  const res = await req(ctx, session, { method: "POST", url: "/api/campaigns", payload: mp.payload, headers: mp.headers });
  if (res.statusCode !== 200) throw new Error(`create campaign failed: ${res.body}`);
  return json(res).campaign as { id: string; counts: Record<string, number>; importSummary: Record<string, unknown> };
}

export async function createService(ctx: TestContext, session: Session, name = "Fleet Analytics") {
  const res = await req(ctx, session, {
    method: "POST",
    url: "/api/services",
    payload: {
      name,
      description: "Real-time analytics for logistics fleets: utilisation, routing and maintenance signals.",
      targetAudience: "Operations leaders at logistics companies",
      valueProps: ["cut idle time by 20%", "predictive maintenance"],
      proofPoints: ["Used by 40 fleets"],
      tags: ["logistics"],
    },
  });
  if (res.statusCode !== 200) throw new Error(`create service failed: ${res.body}`);
  return json(res).service as { id: string };
}

/** Raw RFC822 email for inbound tests. */
export function rawEmail(opts: { from: string; to: string; subject: string; text: string; inReplyTo?: string; references?: string; extraHeaders?: string; messageId?: string }): string {
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${opts.messageId ?? `<reply-${Date.now()}@theirmail.example>`}`,
  ];
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  if (opts.extraHeaders) lines.push(opts.extraHeaders);
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", opts.text, "");
  return lines.join("\r\n");
}

export function snsNotification(message: unknown, topicArn = "arn:aws:sns:us-east-1:123456789012:mailapp-events"): Record<string, unknown> {
  return {
    Type: "Notification",
    MessageId: `sns-${Date.now()}-${Math.random()}`,
    TopicArn: topicArn,
    Message: JSON.stringify(message),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "1",
    Signature: "test",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
  };
}

export function sesEvent(eventType: string, messageId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ts = new Date().toISOString();
  return {
    eventType,
    mail: { messageId, timestamp: ts, destination: ["lead1@gmail.com"], tags: {} },
    ...extra,
  };
}
