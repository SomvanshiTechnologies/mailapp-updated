import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PROVIDER_LABELS, formatUsd, type LlmProviderName, type ModelOptionDto, type ProviderStatusDto, type ResearchMode } from "@mailapp/shared";
import { api } from "../lib/api";

export interface ModelCatalogue {
  models: ModelOptionDto[];
  providers: ProviderStatusDto[];
  researchModes: Array<{ mode: ResearchMode; label: string; description: string; effort: string; maxSearches: number; maxFetches: number }>;
  ratesCapturedAt: string;
  mockMode: boolean;
}

/** Shared query so the picker, Settings and the campaign forms hit the endpoint once. */
export function useModelCatalogue() {
  return useQuery({
    queryKey: ["llm", "models"],
    queryFn: () => api.get<ModelCatalogue>("/api/llm/models"),
    staleTime: 60_000,
  });
}

const TIER_ORDER: Record<ModelOptionDto["tier"], number> = { flagship: 0, balanced: 1, fast: 2 };

/** Batch rows carry a very light green wash; normal rows have no background at all. */
const BATCH_ROW = "bg-emerald-50/70 hover:bg-emerald-100/70";
const NORMAL_ROW = "hover:bg-gray-50";

function providerOrder(p: LlmProviderName): number {
  return ["anthropic", "openai", "gemini", "deepseek", "mock"].indexOf(p);
}

export function BatchTag() {
  return (
    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800" title="Runs through the provider's batch endpoint at half price. Results arrive later, not immediately.">
      batch −50%
    </span>
  );
}

/**
 * Model picker.
 *
 * Every batch-capable model appears twice: once as a normal call and once as a batch call
 * tinted light green. A model whose provider has no API key is shown greyed out with an
 * "Add key" action rather than hidden, so it is obvious what is available and why.
 */
export function ModelSelect({
  value,
  onChange,
  catalogue,
  disabled,
  /** Shown as the first option; selecting it emits "". Used for campaign-level inheritance. */
  inheritLabel,
  /** Filter to models that can do grounded research. */
  requireWebSearch,
  onAddKey,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  catalogue: ModelCatalogue | undefined;
  disabled?: boolean;
  inheritLabel?: string;
  requireWebSearch?: boolean;
  onAddKey?: (provider: string) => void;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const grouped = useMemo(() => {
    const models = (catalogue?.models ?? []).filter((m) => !requireWebSearch || m.webSearch);
    const byProvider = new Map<LlmProviderName, ModelOptionDto[]>();
    for (const m of models) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    for (const list of byProvider.values()) {
      list.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.label.localeCompare(b.label) || Number(a.batch) - Number(b.batch));
    }
    return [...byProvider.entries()].sort((a, b) => providerOrder(a[0]) - providerOrder(b[0]));
  }, [catalogue, requireWebSearch]);

  const selected = catalogue?.models.find((m) => m.value === value);
  const label = !value && inheritLabel ? inheritLabel : (selected?.label ?? (value || "Select a model"));

  return (
    <div className="relative" ref={boxRef}>
      <button
        id={id}
        type="button"
        className="input flex w-full items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:bg-gray-50"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{label}</span>
          {selected?.batch && <BatchTag />}
          {selected && !selected.available && <span className="text-xs text-amber-700">no API key</span>}
        </span>
        <span className="shrink-0 text-xs text-gray-400">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-30 mt-1 max-h-96 w-full min-w-[22rem] overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg"
        >
          {inheritLabel && (
            <button
              type="button"
              role="option"
              aria-selected={!value}
              className={"flex w-full flex-col px-3 py-2 text-left text-sm " + NORMAL_ROW}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              <span className="font-medium">{inheritLabel}</span>
              <span className="text-xs text-gray-500">Follow the organisation setting; changes there apply here too.</span>
            </button>
          )}
          {grouped.map(([provider, models]) => {
            const unavailable = models.every((m) => !m.available);
            return (
              <div key={provider}>
                <div className="flex items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-3 py-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{PROVIDER_LABELS[provider]}</span>
                  {unavailable && onAddKey && provider !== "mock" && (
                    <button
                      type="button"
                      className="text-[11px] font-medium text-brand-700 hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        onAddKey(provider);
                      }}
                    >
                      + Add API key
                    </button>
                  )}
                </div>
                {models.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    role="option"
                    aria-selected={m.value === value}
                    disabled={!m.available}
                    title={m.available ? m.note : `${PROVIDER_LABELS[provider]} has no API key configured yet.`}
                    className={
                      "flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-45 " +
                      (m.batch ? BATCH_ROW : NORMAL_ROW) +
                      (m.value === value ? " ring-1 ring-inset ring-brand-300" : "")
                    }
                    onClick={() => {
                      onChange(m.value);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{m.label}</span>
                        {m.batch && <BatchTag />}
                        {!m.available && <span className="text-[10px] text-amber-700">no key</span>}
                      </span>
                      <span className="mt-0.5 block text-xs text-gray-500">{m.note}</span>
                    </span>
                    <span className="shrink-0 text-right text-[11px] leading-tight text-gray-500">
                      <span className="block">{formatUsd(m.indicative.researchMicroUsd)}/lead</span>
                      <span className="block">{formatUsd(m.indicative.draftMicroUsd)}/email</span>
                      {m.rateOverridden && <span className="block text-amber-700">custom rate</span>}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
          {!grouped.length && <div className="px-3 py-3 text-sm text-gray-500">No models match this filter.</div>}
          <div className="border-t border-gray-100 px-3 py-1.5 text-[11px] text-gray-400">
            Green rows use the provider's batch endpoint: half price, results arrive later.
          </div>
        </div>
      )}
    </div>
  );
}

/** Radio group for the three research intensities. */
export function ResearchModeSelect({
  value,
  onChange,
  catalogue,
  disabled,
  inheritLabel,
}: {
  value: ResearchMode | "";
  onChange: (v: ResearchMode | "") => void;
  catalogue: ModelCatalogue | undefined;
  disabled?: boolean;
  inheritLabel?: string;
}) {
  const modes = catalogue?.researchModes ?? [];
  return (
    <div className="space-y-1.5">
      {inheritLabel && (
        <label className="flex cursor-pointer items-start gap-2 rounded border border-gray-200 px-2.5 py-2 text-sm">
          <input type="radio" className="mt-0.5" disabled={disabled} checked={value === ""} onChange={() => onChange("")} />
          <span>
            <span className="font-medium">{inheritLabel}</span>
            <span className="block text-xs text-gray-500">Follow the organisation setting.</span>
          </span>
        </label>
      )}
      {modes.map((m) => (
        <label
          key={m.mode}
          className={
            "flex cursor-pointer items-start gap-2 rounded border px-2.5 py-2 text-sm " +
            (value === m.mode ? "border-brand-400 bg-brand-50" : "border-gray-200")
          }
        >
          <input type="radio" className="mt-0.5" disabled={disabled} checked={value === m.mode} onChange={() => onChange(m.mode)} />
          <span>
            <span className="font-medium">{m.label}</span>
            <span className="block text-xs text-gray-500">{m.description}</span>
            <span className="mt-0.5 block text-[11px] text-gray-400">
              effort {m.effort} · up to {m.maxSearches} searches, {m.maxFetches} page fetches
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
