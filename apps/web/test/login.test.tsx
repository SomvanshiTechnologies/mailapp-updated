import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../src/hooks/useAuth";
import { LoginPage } from "../src/pages/LoginPage";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.restoreAllMocks());

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>Dashboard home</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  it("submits credentials and navigates on success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "unauthorized", message: "Authentication required" } })) // /me
      .mockResolvedValueOnce(jsonResponse(200, { user: { id: "1", email: "a@b.co", name: "A", role: "admin", isActive: true, lastLoginAt: null, createdAt: "" } }));
    renderLogin();
    await screen.findByLabelText(/email/i);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "Password-12345!" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(screen.getByText("Dashboard home")).toBeInTheDocument());
    const loginCall = fetchMock.mock.calls.find((c) => (c[0] as string) === "/api/auth/login")!;
    expect(JSON.parse((loginCall[1] as RequestInit).body as string)).toEqual({ email: "a@b.co", password: "Password-12345!" });
  });

  it("shows the API error message on failure", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "unauthorized", message: "Authentication required" } }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "invalid_credentials", message: "Invalid email or password" } }));
    renderLogin();
    await screen.findByLabelText(/email/i);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "Password-12345!" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
  });
});
