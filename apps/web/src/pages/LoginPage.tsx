import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { errorMessage } from "../lib/api";

export function LoginPage() {
  const { user, login, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      const from = (location.state as { from?: string } | null)?.from ?? "/";
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="relative flex min-h-full flex-col items-center justify-center overflow-hidden bg-cream-50 p-4"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex select-none items-center justify-center text-[min(46vw,34rem)] font-black italic leading-none tracking-tighter text-gray-900/[0.035]"
      >
        SGT
      </div>
      <div className="mb-6">
        <img src="/brand/sgt-logo.jpeg" alt="Somvanshi Global Technologies" className="relative h-24 w-auto mix-blend-multiply" />
      </div>
      <form onSubmit={submit} className="card relative z-10 w-full max-w-sm space-y-4 p-6 shadow-pop">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Outreach Engine</h1>
          <p className="text-sm text-gray-500">Sign in to continue</p>
        </div>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            {error}
          </div>
        )}
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="relative z-10 mt-6 text-xs text-gray-500">© Somvanshi Global Technologies · Outreach Engine</p>
    </div>
  );
}
