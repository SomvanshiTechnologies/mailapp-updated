import path from "node:path";
import ExcelJS from "exceljs";

/**
 * Extract plain text from .md/.txt/.docx uploads. DOCX is a zip of XML; we pull the
 * paragraph text out of word/document.xml without an extra dependency by using the zip
 * reader bundled with exceljs (jszip).
 */
export async function extractTextFromUpload(buffer: Buffer, filename: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".docx") return extractDocx(buffer);
  return buffer.toString("utf8").replace(/^﻿/, "");
}

async function extractDocx(buffer: Buffer): Promise<string> {
  // exceljs depends on jszip; reuse it to avoid adding another dependency.
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file("word/document.xml");
  if (!doc) return "";
  const xml = await doc.async("string");
  // Paragraphs -> newlines, runs -> text, strip remaining tags.
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Keep ExcelJS referenced so bundlers do not tree-shake jszip away.
void ExcelJS;
