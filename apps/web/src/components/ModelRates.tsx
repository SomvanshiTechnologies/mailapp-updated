import { useMemo, useState } from "react";
import { PROVIDER_LABELS, type ModelOptionDto, type ModelRateOverride } from "@mailapp/shared";

type Overrides = Record<string, ModelRateOverride>;

/**
 * Administrator overrides of the built-in list prices.
 *
 * The catalogue ships the providers' published rates as of a captured date; they change, and
 * an enterprise agreement may differ from list. An override applies to every future call —
 * calls already recorded keep the price they were charged, so history never moves.
 */
export function ModelRatesCard({
  models,
  capturedAt,
  overrides,
  onChange,
  readOnly,
}: {
  models: ModelOptionDto[];
  capturedAt: string | null;
  overrides: Overrides;
  onChange: (v: Overrides) => void;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);

  // One row per model, not per batch variant: the batch rate is derived from the list rate.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return models
      .filter((m) => {
        if (m.batch || seen.has(m.modelKey)) return false;
        seen.add(m.modelKey);
        return true;
      })
      .sort((a, b) => a.providerLabel.localeCompare(b.providerLabel) || a.label.localeCompare(b.label));
  }, [models]);

  const overriddenCount = Object.keys(overrides ?? {}).length;

  const setRate = (m: ModelOptionDto, field: keyof ModelRateOverride, raw: string) => {
    const next: Overrides = { ...overrides };
    const current: ModelRateOverride = next[m.modelKey] ?? {
      input: m.rates.input,
      output: m.rates.output,
      cacheRead: m.rates.cacheRead,
      cacheWrite: m.rates.cacheWrite,
    };
    if (raw === "") {
      // Clearing a field drops back to the built-in rate for that field.
      const { [field]: _removed, ...rest } = current;
      const merged = { input: current.input, output: current.output, ...rest } as ModelRateOverride;
      next[m.modelKey] = merged;
    } else {
      next[m.modelKey] = { ...current, [field]: Number(raw) };
    }
    onChange(next);
  };

  const reset = (modelKey: string) => {
    const next = { ...overrides };
    delete next[modelKey];
    onChange(next);
  };

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Token rates</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Built-in list prices{capturedAt ? ` as published on ${capturedAt}` : ""}, in US dollars per million tokens.
            Override any of them to match your contract; already-recorded calls keep the price they were charged.
            {overriddenCount > 0 && <strong> {overriddenCount} model{overriddenCount === 1 ? "" : "s"} overridden.</strong>}
          </p>
        </div>
        <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide rates" : "Show rates"}
        </button>
      </div>

      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="py-1.5 pr-3 font-medium">Model</th>
                <th className="py-1.5 pr-2 text-right font-medium">Input</th>
                <th className="py-1.5 pr-2 text-right font-medium">Output</th>
                <th className="py-1.5 pr-2 text-right font-medium">Cached in</th>
                <th className="py-1.5 pr-2 text-right font-medium">Cache write</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const o = overrides?.[m.modelKey];
                const cell = (field: keyof ModelRateOverride, fallback: number | null) => (
                  <td className="py-1 pr-2 text-right">
                    <input
                      className="input w-20 py-1 text-right text-xs tabular-nums"
                      type="number"
                      min={0}
                      step={0.01}
                      disabled={readOnly || (fallback === null && !o)}
                      value={o?.[field] ?? fallback ?? ""}
                      placeholder={fallback === null ? "n/a" : String(fallback)}
                      onChange={(e) => setRate(m, field, e.target.value)}
                    />
                  </td>
                );
                return (
                  <tr key={m.modelKey} className={"border-b border-gray-100 " + (o ? "bg-amber-50/60" : "")}>
                    <td className="py-1 pr-3">
                      <span className="font-medium">{m.label}</span>
                      <span className="block text-[11px] text-gray-400">
                        {PROVIDER_LABELS[m.provider]} · {m.model}
                      </span>
                    </td>
                    {cell("input", m.rates.input)}
                    {cell("output", m.rates.output)}
                    {cell("cacheRead", m.rates.cacheRead)}
                    {cell("cacheWrite", m.rates.cacheWrite)}
                    <td className="py-1 text-right">
                      {o && !readOnly && (
                        <button type="button" className="btn-ghost btn-sm text-xs" onClick={() => reset(m.modelKey)}>
                          Reset
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-gray-400">
            Batch prices are half of these, applied automatically. Remember to save the settings page after editing rates.
          </p>
        </div>
      )}
    </section>
  );
}
