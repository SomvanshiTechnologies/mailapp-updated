import ExcelJS from "exceljs";
import { LEAD_COLUMNS, SERVICE_COLUMNS, mapHeaders, type LeadColumnKey, type ServiceColumnKey } from "@mailapp/shared";
import { AppError } from "../../lib/errors.js";

export interface ParsedSheet {
  headers: string[];
  rows: Array<Record<string, string>>; // header -> cell text, sheet order preserved
  sheetName: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v);
}

export function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text);
    if ("result" in v) return v.result === undefined || v.result === null ? "" : String(v.result);
    if (v instanceof Date) return v.toISOString();
    if ("hyperlink" in v) return String((v as { text?: string }).text ?? v.hyperlink);
  }
  return String(v).trim();
}

/**
 * Parse a worksheet of an xlsx/csv buffer into header-keyed rows. With `preferSheet`, a
 * worksheet of that name is used when present; otherwise the first non-empty one.
 */
export async function parseSheet(buffer: Buffer, filename: string, preferSheet?: string): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  const lower = filename.toLowerCase();
  let ws: ExcelJS.Worksheet | undefined;
  try {
    if (lower.endsWith(".csv")) {
      const { Readable } = await import("node:stream");
      ws = await wb.csv.read(Readable.from(buffer));
    } else {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const preferred = preferSheet ? wb.worksheets.find((w) => w.name.toLowerCase() === preferSheet.toLowerCase() && w.rowCount > 0) : undefined;
      ws = preferred ?? wb.worksheets.find((w) => w.rowCount > 0) ?? wb.worksheets[0];
    }
  } catch (err) {
    throw AppError.badRequest(`Could not read spreadsheet: ${(err as Error).message}`);
  }
  if (!ws) throw AppError.badRequest("Spreadsheet contains no worksheets");

  // Header row = first row with at least one non-empty cell.
  let headerRowNo = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
    const row = ws.getRow(r);
    const hasValue = row.values && (row.values as unknown[]).some((v) => v !== null && v !== undefined && String(v).trim() !== "");
    if (hasValue) {
      headerRowNo = r;
      break;
    }
  }
  if (!headerRowNo) throw AppError.badRequest("Spreadsheet is empty");

  const headerRow = ws.getRow(headerRowNo);
  const headers: string[] = [];
  const colIndex: number[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const h = cellText(cell).trim();
    if (h) {
      headers.push(h);
      colIndex.push(col);
    }
  });
  if (headers.length === 0) throw AppError.badRequest("No header row found");

  const rows: Array<Record<string, string>> = [];
  for (let r = headerRowNo + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rec: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      const t = cellText(row.getCell(colIndex[i])).trim();
      rec[h] = t;
      if (t) any = true;
    });
    if (any) rows.push(rec);
  }
  return { headers, rows, sheetName: ws.name };
}

export interface LeadImportRow {
  rowNumber: number;
  email: string;
  fields: Partial<Record<LeadColumnKey, string>>;
  extra: Record<string, string>;
}

export interface LeadImportResult {
  headerMap: Record<string, LeadColumnKey>;
  unmapped: string[];
  missingRequired: LeadColumnKey[];
  valid: LeadImportRow[];
  invalid: Array<{ row: number; reason: string }>;
  duplicates: number;
  totalRows: number;
}

/** Map + validate parsed rows into lead records. Duplicates (by email) keep the first occurrence. */
export function buildLeadImport(sheet: ParsedSheet): LeadImportResult {
  const { mapped, unmapped, missingRequired } = mapHeaders(sheet.headers, LEAD_COLUMNS);
  const valid: LeadImportRow[] = [];
  const invalid: Array<{ row: number; reason: string }> = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const emailHeader = Object.entries(mapped).find(([, k]) => k === "email")?.[0];

  sheet.rows.forEach((rec, i) => {
    const rowNumber = i + 2; // 1-based, header is row 1 (approximation for reporting)
    const fields: Partial<Record<LeadColumnKey, string>> = {};
    const extra: Record<string, string> = {};
    for (const [h, v] of Object.entries(rec)) {
      const key = mapped[h];
      if (key) fields[key] = v;
      else extra[h] = v;
    }
    const rawEmail = emailHeader ? rec[emailHeader] ?? "" : "";
    const email = normalizeEmail(rawEmail);
    if (!email) {
      invalid.push({ row: rowNumber, reason: "missing email" });
      return;
    }
    if (!isValidEmail(email)) {
      invalid.push({ row: rowNumber, reason: `invalid email "${rawEmail}"` });
      return;
    }
    if (seen.has(email)) {
      duplicates++;
      return;
    }
    seen.add(email);
    if (fields.website) fields.website = fields.website.trim();
    valid.push({ rowNumber, email, fields, extra });
  });

  return { headerMap: mapped, unmapped, missingRequired, valid, invalid, duplicates, totalRows: sheet.rows.length };
}

export interface ServiceImportRow {
  rowNumber: number;
  fields: Partial<Record<ServiceColumnKey, string>>;
}

export function buildServiceImport(sheet: ParsedSheet): {
  rows: ServiceImportRow[];
  errors: Array<{ row: number; reason: string }>;
  missingRequired: ServiceColumnKey[];
} {
  const { mapped, missingRequired } = mapHeaders(sheet.headers, SERVICE_COLUMNS);
  const rows: ServiceImportRow[] = [];
  const errors: Array<{ row: number; reason: string }> = [];
  sheet.rows.forEach((rec, i) => {
    const fields: Partial<Record<ServiceColumnKey, string>> = {};
    for (const [h, v] of Object.entries(rec)) {
      const key = mapped[h];
      if (key) fields[key] = v;
    }
    if (!fields.name?.trim()) errors.push({ row: i + 2, reason: "missing name" });
    else if (!fields.description?.trim()) errors.push({ row: i + 2, reason: "missing description" });
    else rows.push({ rowNumber: i + 2, fields });
  });
  return { rows, errors, missingRequired };
}

/** Split "a; b, c" style cells into a list. */
export function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(/[;\n|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
