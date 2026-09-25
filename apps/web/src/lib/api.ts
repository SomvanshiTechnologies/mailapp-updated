export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** multipart form data; JSON body is ignored when set */
  form?: FormData;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** internal: prevents infinite refresh loops */
  _retried?: boolean;
}

let refreshInFlight: Promise<boolean> | null = null;

async function parseError(res: Response): Promise<ApiError> {
  let code = "http_error";
  let message = res.statusText || `HTTP ${res.status}`;
  let details: unknown;
  try {
    const data = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (data?.error) {
      code = data.error.code ?? code;
      message = data.error.message ?? message;
      details = data.error.details;
    }
  } catch {
    /* non-JSON body */
  }
  return new ApiError(res.status, code, message, details);
}

export function buildQuery(query?: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "X-Requested-With": "mailapp" },
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["X-Requested-With"] = "mailapp";
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path + buildQuery(opts.query), {
    method,
    headers,
    body,
    credentials: "include",
    signal: opts.signal,
  });

  if (res.ok) {
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  const err = await parseError(res);
  if (err.status === 401 && err.code === "token_expired" && !opts._retried) {
    const ok = await tryRefresh();
    if (ok) return request<T>(path, { ...opts, _retried: true });
  }
  throw err;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions["query"]) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", form }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "validation_error" && Array.isArray(err.details)) {
      const first = err.details[0] as { path?: unknown[]; message?: string } | undefined;
      if (first?.message) {
        const p = Array.isArray(first.path) && first.path.length ? `${first.path.join(".")}: ` : "";
        return `${p}${first.message}`;
      }
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
