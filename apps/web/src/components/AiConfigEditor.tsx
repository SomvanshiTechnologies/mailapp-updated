import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BATCH_STRATEGIES,
  BATCH_STRATEGY_LABELS,
  formatUsd,
  type BatchStrategy,
  type CampaignAiConfig,
  type CostEstimate,
  type ResearchMode,
  type ResolvedAiConfig,
} from "@mailapp/shared";
import { api } from "../lib/api";
import { Banner, Field } from "./ui";
import { EstimateTable } from "./CostPanel";
import { ModelSelect, ResearchModeSelect, useModelCatalogue, type ModelCatalogue } from "./ModelSelect";

/** A campaign's AI overrides as the form holds them: "" means inherit. */
export interface AiConfigForm {
  researchModel: string;
  draftModel: string;
  researchMode: ResearchMode | "";
  batchStrategy: BatchStrategy | "";
}

export const EMPTY_AI_FORM: AiConfigForm = { researchModel: "", draftModel: "", researchMode: "", batchStrategy: "" };

export function aiFormFrom(config: CampaignAiConfig | null | undefined): AiConfigForm {
  return {
    researchModel: config?.researchModel ?? "",
    draftModel: config?.draftModel ?? "",
    researchMode: config?.researchMode ?? "",
    batchStrategy: config?.batchStrategy ?? "",
  };
}

/** Only the fields that were actually overridden; undefined when nothing was. */
export function aiConfigFromForm(form: AiConfigForm): CampaignAiConfig | undefined {
  const out: CampaignAiConfig = {};
  if (form.researchModel) out.researchModel = form.researchModel;
  if (form.draftModel) out.draftModel = form.draftModel;
  if (form.researchMode) out.researchMode = form.researchMode;
  if (form.batchStrategy) out.batchStrategy = form.batchStrategy;
  return Object.keys(out).length ? out : undefined;
}

interface EstimateResponse {
  estimate: CostEstimate;
  ai: ResolvedAiConfig;
  ready: { research: boolean; draft: boolean };
}

/**
 * Live cost projection for a campaign that does not exist yet (the new-campaign wizard) or
 * for an edit in progress. Recomputed server-side so the rates and the profile are the same
 * ones the pipeline will actually charge.
 */
export function useCostEstimate(input: { leads: number; steps: number; form: AiConfigForm; enabled?: boolean }) {
  const { leads, steps, form } = input;
  return useQuery({
    queryKey: ["llm", "estimate", leads, steps, form.researchModel, form.draftModel, form.researchMode],
    queryFn: () =>
      api.post<EstimateResponse>("/api/llm/estimate", {
        leads,
        steps,
        researchModel: form.researchModel || undefined,
        draftModel: form.draftModel || undefined,
        researchMode: form.researchMode || undefined,
      }),
    enabled: (input.enabled ?? true) && leads > 0,
    staleTime: 30_000,
  });
}

/**
 * The "AI & cost" card. Used on the new-campaign wizard and in a campaign's settings tab;
 * `inherit` labels tell the operator what the organisation default currently is, so leaving a
 * field alone is an informed choice rather than a blank.
 */
export function AiConfigEditor({
  value,
  onChange,
  disabled,
  orgDefaults,
  leads,
  steps,
  catalogue: catalogueProp,
  onAddKey,
}: {
  value: AiConfigForm;
  onChange: (v: AiConfigForm) => void;
  disabled?: boolean;
  /** The organisation settings, for the "inherit" labels. */
  orgDefaults: { researchModelLabel: string; draftModelLabel: string; researchMode: ResearchMode; batchStrategy: BatchStrategy } | null;
  /** Lead and step counts driving the projection. */
  leads: number;
  steps: number;
  catalogue?: ModelCatalogue;
  onAddKey?: (provider: string) => void;
}) {
  const catalogueQuery = useModelCatalogue();
  const catalogue = catalogueProp ?? catalogueQuery.data;
  const set = <K extends keyof AiConfigForm>(k: K, v: AiConfigForm[K]) => onChange({ ...value, [k]: v });

  const estimate = useCostEstimate({ leads, steps, form: value, enabled: !disabled || leads > 0 });
  const usesBatch = estimate.data?.ai.usesBatch ?? false;
  const notReady = useMemo(() => {
    const r = estimate.data?.ready;
    if (!r) return null;
    if (!r.research && !r.draft) return "Neither selected model has an API key configured.";
    if (!r.research) return "The research model's provider has no API key configured.";
    if (!r.draft) return "The drafting model's provider has no API key configured.";
    return null;
  }, [estimate.data]);

  return (
    <div className="space-y-4">
      {catalogue?.mockMode && (
        <Banner kind="warning">
          The server is running with the offline mock provider, so every model selection below is ignored and nothing is
          charged. Set <code>LLM_PROVIDER=live</code> to use real models.
        </Banner>
      )}
      {notReady && <Banner kind="warning">{notReady} Add one under Settings → Model providers, or choose a different model.</Banner>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Research model" hint="Grounded research needs a model with web search; models without it work from the lead's website only.">
          <ModelSelect
            value={value.researchModel}
            onChange={(v) => set("researchModel", v)}
            catalogue={catalogue}
            disabled={disabled}
            inheritLabel={orgDefaults ? `Inherit — ${orgDefaults.researchModelLabel}` : "Inherit organisation default"}
            onAddKey={onAddKey}
          />
        </Field>
        <Field label="Drafting model" hint="Runs once per email in the sequence. The biggest lever on total cost.">
          <ModelSelect
            value={value.draftModel}
            onChange={(v) => set("draftModel", v)}
            catalogue={catalogue}
            disabled={disabled}
            inheritLabel={orgDefaults ? `Inherit — ${orgDefaults.draftModelLabel}` : "Inherit organisation default"}
            onAddKey={onAddKey}
          />
        </Field>
      </div>

      <Field label="Research depth">
        <ResearchModeSelect
          value={value.researchMode}
          onChange={(v) => set("researchMode", v)}
          catalogue={catalogue}
          disabled={disabled}
          inheritLabel={orgDefaults ? `Inherit — ${orgDefaults.researchMode}` : "Inherit organisation default"}
        />
      </Field>

      {usesBatch && (
        <Field
          label="Batch grouping"
          hint="Batch endpoints are asynchronous: results usually arrive within an hour and can take up to 24."
        >
          <select
            className="input"
            disabled={disabled}
            value={value.batchStrategy}
            onChange={(e) => set("batchStrategy", e.target.value as BatchStrategy | "")}
          >
            <option value="">{orgDefaults ? `Inherit — ${BATCH_STRATEGY_LABELS[orgDefaults.batchStrategy]}` : "Inherit organisation default"}</option>
            {BATCH_STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {BATCH_STRATEGY_LABELS[s]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            <strong>One batch per campaign</strong> submits everything at once — cheapest, but no drafts until it returns.{" "}
            <strong>Rolling batches</strong> flush on a timer so drafts trickle in.
          </p>
        </Field>
      )}

      <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Estimated cost</h3>
          <span className="text-xs text-gray-500">
            {leads.toLocaleString()} lead{leads === 1 ? "" : "s"} × {steps} step{steps === 1 ? "" : "s"}
          </span>
        </div>
        {leads === 0 ? (
          <p className="text-sm text-gray-500">Upload a lead sheet to see the projected cost.</p>
        ) : estimate.isLoading ? (
          <p className="text-sm text-gray-500">Calculating…</p>
        ) : estimate.data ? (
          <>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-2xl font-semibold tabular-nums">{formatUsd(estimate.data.estimate.totalMicroUsd)}</span>
              <span className="text-sm text-gray-600">
                {formatUsd(estimate.data.estimate.perLeadMicroUsd)} per lead · {formatUsd(estimate.data.estimate.perEmailMicroUsd)} per email
              </span>
            </div>
            <EstimateTable estimate={estimate.data.estimate} />
            <p className="mt-2 text-[11px] text-gray-400">
              An estimate from average token counts for the chosen research depth. Actual spend is tracked per lead and per
              email once the campaign runs.
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-500">Could not calculate an estimate.</p>
        )}
      </div>
    </div>
  );
}
