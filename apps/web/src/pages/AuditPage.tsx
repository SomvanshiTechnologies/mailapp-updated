import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AuditFacets, AuditLogDto, Paginated } from "@mailapp/shared";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { EmptyState, ErrorBox, JsonView, PageHeader, Pagination, Spinner } from "../components/ui";

interface Filters {
  q: string;
  action: string;
  user: string;
  entityType: string;
  entityId: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { q: "", action: "", user: "", entityType: "", entityId: "", from: "", to: "" };
const PAGE_SIZES = [25, 50, 100, 200];

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [filters, setFilters] = useState<Filters>(EMPTY);

  const facets = useQuery({
    queryKey: ["audit", "facets"],
    queryFn: () => api.get<AuditFacets>("/api/audit/facets"),
    staleTime: 60_000,
  });
  const q = useQuery({
    queryKey: ["audit", page, pageSize, filters],
    queryFn: () => api.get<Paginated<AuditLogDto>>("/api/audit", { page, pageSize, ...filters }),
    placeholderData: keepPreviousData,
  });

  // Action groups ("campaign", "user", ...) go first in the drop-down, then every exact action.
  const actionOptions = useMemo(() => {
    const actions = facets.data?.actions ?? [];
    const groups = [...new Set(actions.map((a) => a.split(".")[0]))];
    return { groups, actions };
  }, [facets.data]);

  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const active = Object.values(filters).some(Boolean);

  return (
    <div>
      <PageHeader
        title="Audit log"
        actions={
          <button className="btn-secondary btn-sm" disabled={!active} onClick={() => set(EMPTY)}>
            Clear filters
          </button>
        }
      />
      <div className="card mb-4 grid grid-cols-1 gap-2 md:grid-cols-3 lg:grid-cols-4">
        <input
          className="input lg:col-span-2"
          placeholder="Search action, user, entity id, IP or details"
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
          aria-label="Search"
        />
        <select className="input" value={filters.action} onChange={(e) => set({ action: e.target.value })} aria-label="Filter by action">
          <option value="">All actions</option>
          {actionOptions.groups.length > 0 && (
            <optgroup label="Groups">
              {actionOptions.groups.map((g) => (
                <option key={g} value={g}>
                  {g}.*
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Actions">
            {actionOptions.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </optgroup>
        </select>
        <select className="input" value={filters.user} onChange={(e) => set({ user: e.target.value })} aria-label="Filter by user">
          <option value="">All users</option>
          <option value="system">system</option>
          {(facets.data?.users ?? []).map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={filters.entityType}
          onChange={(e) => set({ entityType: e.target.value })}
          aria-label="Filter by entity type"
        >
          <option value="">All entity types</option>
          {(facets.data?.entityTypes ?? []).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="Entity id"
          value={filters.entityId}
          onChange={(e) => set({ entityId: e.target.value.trim() })}
          aria-label="Filter by entity id"
        />
        <label className="flex items-center gap-2 text-xs text-gray-600">
          From
          <input className="input" type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} aria-label="From date" />
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-600">
          To
          <input className="input" type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} aria-label="To date" />
        </label>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox message={(q.error as Error).message} />
      ) : !q.data?.items.length ? (
        <EmptyState title={active ? "No audit entries match these filters" : "No audit entries"} />
      ) : (
        <div className={`card p-0 ${q.isFetching ? "opacity-70" : ""}`}>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>User</th>
                <th>Action</th>
                <th>Entity</th>
                <th>IP</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap text-xs text-gray-500">{formatDate(a.createdAt)}</td>
                  <td className="text-xs">
                    <button className="hover:underline" onClick={() => set({ user: a.userEmail ?? "system" })} title="Filter by this user">
                      {a.userEmail ?? "system"}
                    </button>
                  </td>
                  <td className="font-mono text-xs">
                    <button className="hover:underline" onClick={() => set({ action: a.action })} title="Filter by this action">
                      {a.action}
                    </button>
                  </td>
                  <td className="text-xs text-gray-600">
                    {a.entityType}{" "}
                    {a.entityId && (
                      <button
                        className="font-mono text-gray-400 hover:underline"
                        onClick={() => set({ entityId: a.entityId ?? "" })}
                        title={`Filter by ${a.entityId}`}
                      >
                        {a.entityId.slice(0, 8)}
                      </button>
                    )}
                  </td>
                  <td className="text-xs text-gray-500">{a.ip ?? ""}</td>
                  <td>{a.metadata && <JsonView value={a.metadata} label="metadata" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center gap-3 px-3">
            <div className="flex-1">
              <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
            </div>
            <label className="flex items-center gap-1 text-xs text-gray-600">
              Rows
              <select
                className="input w-20"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Rows per page"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
