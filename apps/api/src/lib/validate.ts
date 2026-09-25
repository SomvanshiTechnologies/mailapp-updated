import type { ZodTypeAny, z } from "zod";
import { AppError } from "./errors.js";

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw AppError.validation(
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code })),
    );
  }
  return result.data;
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export function requireUuid(v: string, what = "id"): string {
  if (!isUuid(v)) throw AppError.badRequest(`Invalid ${what}`);
  return v;
}
