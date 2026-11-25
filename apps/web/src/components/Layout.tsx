import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SystemStatus } from "@mailapp/shared";
import { useAuth } from "../hooks/useAuth";
import { api } from "../lib/api";
import {
  Activity,
  ChevronLeft,
  ClipboardCheck,
  FileText,
  History,
  LayoutDashboard,
  Menu,
  Send,
  ShieldOff,
  SlidersHorizontal,
  UserCircle,
  Users,
  X,
  Briefcase,
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

const GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "Workspace",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard },
      { to: "/campaigns", label: "Campaigns", icon: Send },
      { to: "/review", label: "Review queue", icon: ClipboardCheck },
    ],
  },
  {
    title: "Content",
    items: [
      { to: "/services", label: "Services", icon: Briefcase },
      { to: "/instructions", label: "Instructions", icon: FileText },
      { to: "/suppressions", label: "Suppressions", icon: ShieldOff },
    ],
  },
  {
    title: "Administration",
    items: [
      { to: "/users", label: "Users", adminOnly: true, icon: Users },
      { to: "/audit", label: "Audit log", adminOnly: true, icon: History },
      { to: "/system", label: "System", icon: Activity },
      { to: "/settings", label: "Settings", icon: SlidersHorizontal },
      { to: "/profile", label: "My profile", icon: UserCircle },
    ],
  },
];

const COLLAPSE_KEY = "outreach.sidebar.collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Official SGT logo, natural aspect ratio. The JPEG has a white background, so it sits on a white chip. */
function BrandLogo() {
  return (
    <Link to="/" className="flex shrink-0 items-center" aria-label="Outreach Engine home">
      <span className="flex h-11 items-center">
        <img src="/brand/sgt-logo.jpeg" alt="Somvanshi Global Technologies" className="h-10 w-auto mix-blend-multiply" />
      </span>
    </Link>
  );
}

export function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const status = useQuery({
    queryKey: ["system", "status"],
    queryFn: () => api.get<SystemStatus>("/api/system/status"),
    refetchInterval: 60_000,
  });
  const mock = status.data && (status.data.sesMode === "mock" || status.data.llmProvider === "mock");
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => !n.adminOnly || isAdmin) })).filter((g) => g.items.length > 0);
  const flat = groups.flatMap((g) => g.items);
  const initials = (user?.name ?? "?")
    .split(/\s+/)
    .map((p) => p.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const cap = status.data?.dailyCap ?? 0;
  const pct = status.data && cap ? Math.min(100, (status.data.sentToday / cap) * 100) : 0;

  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* storage unavailable: the choice just won't persist */
      }
      return !c;
    });

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-cream-50 text-gray-900">
        <div className="flex h-[3.25rem] items-center gap-4 px-4">
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 md:hidden"
          >
            {open ? <X size={16} /> : <Menu size={16} />}
          </button>
          <BrandLogo />
          <span className="hidden border-l border-gray-200 pl-4 text-xs font-medium tracking-wide text-gray-500 lg:inline">Outreach Engine</span>
          <div className="flex flex-1 items-center">
            {mock && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-50 px-2.5 py-0.5 text-2xs font-medium text-gray-600 ring-1 ring-inset ring-gray-200">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                {status.data?.sesMode === "mock" ? "SES mock mode" : ""}
                {status.data?.sesMode === "mock" && status.data?.llmProvider === "mock" ? " · " : ""}
                {status.data?.llmProvider === "mock" ? "LLM mock provider" : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2.5 sm:flex">
              <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-50 text-2xs font-semibold text-brand-700">
                {initials}
              </span>
              <span className="leading-tight">
                <span className="block max-w-40 truncate text-xs font-medium text-gray-900">{user?.name}</span>
                <span className="block text-2xs text-gray-500">{user?.role}</span>
              </span>
            </div>
            <button
              className="inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              onClick={async () => {
                await logout();
                navigate("/login");
              }}
            >
              Log out
            </button>
          </div>
        </div>
        {open && (
          <nav aria-label="Menu" className="max-h-[calc(100vh-3.25rem)] overflow-y-auto border-t border-gray-200 bg-cream-50 px-4 py-2 md:hidden">
            <ul className="space-y-1">
              {flat.map((n) => (
                <li key={n.to}>
                  <NavLink
                    to={n.to}
                    end={n.to === "/"}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium " +
                      (isActive ? "bg-brand-50 text-brand-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900")
                    }
                  >
                    <n.icon size={18} strokeWidth={1.75} className="shrink-0" />
                    {n.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>
      <div className="flex flex-1">
        <aside
          aria-label="Main"
          className={
            "sticky top-[3.25rem] hidden h-[calc(100vh-3.25rem)] shrink-0 flex-col border-r border-gray-200 bg-cream-50 transition-[width] duration-150 md:flex " +
            (collapsed ? "w-[4.5rem]" : "w-60")
          }
        >
          <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {groups.map((g, gi) => (
              <div key={g.title} className={gi > 0 ? "mt-4" : ""}>
                {collapsed ? (
                  gi > 0 && <div aria-hidden="true" className="mx-2 mb-2 border-t border-white/10" />
                ) : (
                  <div className="mb-1.5 px-3 text-2xs font-semibold uppercase tracking-wider text-gray-400">{g.title}</div>
                )}
                <ul className="space-y-0.5">
                  {g.items.map((n) => (
                    <li key={n.to}>
                      <NavLink
                        to={n.to}
                        end={n.to === "/"}
                        title={collapsed ? n.label : undefined}
                        aria-label={n.label}
                        className={({ isActive }) =>
                          "group relative flex h-9 items-center rounded-md text-sm font-medium transition-colors " +
                          (collapsed ? "justify-center px-0 " : "gap-3 px-3 ") +
                          (isActive ? "bg-brand-50 text-brand-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900")
                        }
                      >
                        {({ isActive }) => (
                          <>
                            {isActive && <span aria-hidden="true" className="absolute -left-3 bottom-1.5 top-1.5 w-[3px] rounded-r-full bg-brand-600" />}
                            <n.icon size={18} strokeWidth={1.75} className="shrink-0" />
                            {!collapsed && <span className="truncate">{n.label}</span>}
                          </>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div className="space-y-2 border-t border-gray-200 p-3">
            {!collapsed && (
              <div className="rounded-lg border border-gray-200/80 bg-white/70 px-3 py-2.5 text-xs text-gray-500">
                {status.data ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span>
                        v{status.data.version} · {status.data.env}
                      </span>
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    </div>
                    <div className="mt-2 flex items-baseline justify-between">
                      <span>Sent today</span>
                      <span className="font-medium text-gray-900">
                        {status.data.sentToday}/{status.data.dailyCap}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-gray-200">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
                    </div>
                  </>
                ) : (
                  "…"
                )}
              </div>
            )}
            <button
              type="button"
              onClick={toggle}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={"flex h-8 w-full items-center rounded-md text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 " + (collapsed ? "justify-center" : "gap-2 px-3")}
            >
              <ChevronLeft size={16} aria-hidden="true" className={collapsed ? "rotate-180" : ""} />
              {!collapsed && "Collapse"}
            </button>
          </div>
        </aside>
        <main id="main" className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6">
          <div className="mx-auto w-full max-w-[80rem]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
