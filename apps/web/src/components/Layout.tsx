import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SystemStatus } from "@mailapp/shared";
import { useAuth } from "../hooks/useAuth";
import { api } from "../lib/api";

const NAV: Array<{ to: string; label: string; adminOnly?: boolean }> = [
  { to: "/", label: "Dashboard" },
  { to: "/campaigns", label: "Campaigns" },
  { to: "/review", label: "Review queue" },
  { to: "/services", label: "Services" },
  { to: "/instructions", label: "Instructions" },
  { to: "/suppressions", label: "Suppressions" },
  { to: "/settings", label: "Settings" },
  { to: "/users", label: "Users", adminOnly: true },
  { to: "/audit", label: "Audit log", adminOnly: true },
  { to: "/system", label: "System" },
  { to: "/profile", label: "My profile" },
];

export function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const status = useQuery({
    queryKey: ["system", "status"],
    queryFn: () => api.get<SystemStatus>("/api/system/status"),
    refetchInterval: 60_000,
  });
  const mock = status.data && (status.data.sesMode === "mock" || status.data.llmProvider === "mock");

  return (
    <div className="flex min-h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-4 py-4">
          <div className="text-sm font-semibold tracking-tight text-gray-900">Outreach Engine</div>
          <div className="text-xs text-gray-500">Internal outreach console</div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                "block rounded-md px-3 py-1.5 text-sm " +
                (isActive ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700 hover:bg-gray-100")
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-gray-200 p-3 text-xs text-gray-500">
          {status.data ? (
            <div>
              v{status.data.version} · {status.data.env}
              <div>
                Sent today {status.data.sentToday}/{status.data.dailyCap}
              </div>
            </div>
          ) : (
            "…"
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-between border-b border-gray-200 bg-white px-5">
          <div className="text-sm text-gray-500">
            {mock && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                {status.data?.sesMode === "mock" ? "SES mock mode" : ""}
                {status.data?.sesMode === "mock" && status.data?.llmProvider === "mock" ? " · " : ""}
                {status.data?.llmProvider === "mock" ? "LLM mock provider" : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-700">
              {user?.name} <span className="text-gray-400">({user?.role})</span>
            </span>
            <button
              className="btn-secondary btn-sm"
              onClick={async () => {
                await logout();
                navigate("/login");
              }}
            >
              Log out
            </button>
          </div>
        </header>
        <main className="flex-1 p-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
