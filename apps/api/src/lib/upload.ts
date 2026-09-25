import type { FastifyRequest } from "fastify";
import path from "node:path";
import { AppError } from "./errors.js";

export interface UploadedFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  fields: Record<string, string>;
}

/**
 * Read a single multipart file plus any text fields. Rejects files by extension and size.
 */
export async function readUploadedFile(
  req: FastifyRequest,
  allowedExtensions: string[],
  maxBytes = 25 * 1024 * 1024,
): Promise<UploadedFile> {
  if (!req.isMultipart()) throw AppError.badRequest("Expected multipart/form-data upload");
  const fields: Record<string, string> = {};
  let file: UploadedFile | null = null;
  for await (const part of req.parts()) {
    if (part.type === "file") {
      if (file) {
        await part.toBuffer(); // drain
        continue;
      }
      const ext = path.extname(part.filename ?? "").toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        await part.toBuffer();
        throw AppError.badRequest(`Unsupported file type "${ext || "none"}". Allowed: ${allowedExtensions.join(", ")}`);
      }
      const buffer = await part.toBuffer();
      if (buffer.length > maxBytes) throw AppError.badRequest("File too large");
      if (buffer.length === 0) throw AppError.badRequest("File is empty");
      file = { buffer, filename: path.basename(part.filename ?? `upload${ext}`), mimeType: part.mimetype, fields };
    } else {
      fields[part.fieldname] = typeof part.value === "string" ? part.value : String(part.value ?? "");
    }
  }
  if (!file) throw AppError.badRequest("No file uploaded (field name: file)");
  file.fields = fields;
  return file;
}
