import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, buildQuery, errorMessage, request } from "../src/lib/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api client", () => {
  it("builds query strings and skips empty values", () => {
    expect(buildQuery({ a: 1, b: "x", c: undefined, d: null, e: "" })).toBe("?a=1&b=x");
    expect(buildQuery()).toBe("");
  });

  it("sends JSON with CSRF header on mutating requests and credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(200, { ok: true }));
    await api.post("/api/services", { name: "x" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/services");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["X-Requested-With"]).toBe("mailapp");
    expect(init.body).toBe(JSON.stringify({ name: "x" }));
    await api.get("/api/campaigns", { status: "active" });
    const [url2, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url2).toBe("/api/campaigns?status=active");
    expect((init2.headers as Record<string, string>)["X-Requested-With"]).toBeUndefined();
  });

  it("parses API errors into ApiError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(400, { error: { code: "validation_error", message: "Validation failed", details: [{ path: ["name"], message: "Required" }] } }));
    await expect(api.post("/api/x", {})).rejects.toBeInstanceOf(ApiError);
    try {
      await api.post("/api/x", {});
    } catch (err) {
      expect((err as ApiError).code).toBe("validation_error");
      expect(errorMessage(err)).toBe("name: Required");
    }
  });

  it("refreshes once on token_expired and retries the request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "token_expired", message: "Token expired" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [1] }));
    const res = await request<{ items: number[] }>("/api/campaigns");
    expect(res.items).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe("/api/auth/refresh");
  });

  it("does not loop when refresh fails", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "token_expired", message: "Token expired" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(request("/api/campaigns")).rejects.toMatchObject({ status: 401, code: "token_expired" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
