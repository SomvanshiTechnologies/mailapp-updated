export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError("bad_request", message, 400, details);
  }
  static validation(details: unknown, message = "Validation failed"): AppError {
    return new AppError("validation_error", message, 400, details);
  }
  static unauthorized(message = "Authentication required", code = "unauthorized"): AppError {
    return new AppError(code, message, 401);
  }
  static forbidden(message = "Insufficient permissions"): AppError {
    return new AppError("forbidden", message, 403);
  }
  static notFound(what = "Resource"): AppError {
    return new AppError("not_found", `${what} not found`, 404);
  }
  static conflict(message: string, details?: unknown): AppError {
    return new AppError("conflict", message, 409, details);
  }
  static tooMany(message = "Too many requests"): AppError {
    return new AppError("rate_limited", message, 429);
  }
  static internal(message = "Internal error"): AppError {
    return new AppError("internal_error", message, 500);
  }
}

export function errorToRecord(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: unknown; name?: string; $metadata?: unknown; status?: unknown };
    return {
      name: anyErr.name,
      message: anyErr.message,
      code: anyErr.code,
      status: anyErr.status,
      $metadata: anyErr.$metadata,
    };
  }
  return { message: String(err) };
}
