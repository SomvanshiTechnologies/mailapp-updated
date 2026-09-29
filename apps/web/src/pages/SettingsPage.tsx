import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BATCH_STRATEGIES,
  BATCH_STRATEGY_LABELS,
  SettingsSchema,
  type ApprovalMode,
  type BatchStrategy,
  type DeliveryMode,
  type HardRules,
  type ResearchMode,
  type Settings,
  type SettingsDto,
  type SystemStatus,
} from "@mailapp/shared";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { ChipsInput } from "../components/ChipsInput";
import { Banner, ErrorBox, Field, PageHeader, Spinner } from "../components/ui";
import { ModelSelect, ResearchModeSelect, useModelCatalogue } from "../components/ModelSelect";
import { ProviderKeysCard } from "../components/ProviderKeys";
import { ModelRatesCard } from "../components/ModelRates";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { isAdmin } = useAuth();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: SettingsDto }>("/api/settings") });
  const system = useQuery({ queryKey: ["system", "status"], queryFn: () => api.get<SystemStatus>("/api/system/status") });
  const catalogue = useModelCatalogue();
  // Set by a model picker's "Add API key" link so the dialog opens on the right provider.
  const [keyFocus, setKeyFocus] = useState<string | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data && !form) {
      const { updatedAt: _u, ...rest } = q.data.settings;
      setForm(rest);
    }
  }, [q.data, form]);
  const save = useMutation({
    mutationFn: (body: Settings) => api.put<{ settings: SettingsDto }>("/api/settings", body),
    onSuccess: () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["system"] });
      qc.invalidateQueries({ queryKey: ["llm"] });
    },
    onError: (e) => toast.error(e, "Save failed"),
  });

  if (q.isLoading || !form) return <Spinner />;
  if (q.error) return <ErrorBox message={(q.error as Error).message} />;
  const ro = !isAdmin;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const setRule = <K extends keyof HardRules>(k: K, v: HardRules[K]) => setForm((f) => (f ? { ...f, hardRules: { ...f.hardRules, [k]: v } } : f));
  const submit = () => {
    setError(null);
    const parsed = SettingsSchema.safeParse(form);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(`${i.path.join(".")}: ${i.message}`);
      return;
    }
    save.mutate(parsed.data);
  };
  const num = (v: string) => (v === "" ? 0 : Number(v));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Settings"
        subtitle={`Organisation defaults · last updated ${formatDate(q.data?.settings.updatedAt)}`}
        actions={
          <>
            <a className="btn-secondary" href="/api/settings/export" title="Settings, hard rules, instruction documents and services as one Excel file">
              Export xlsx
            </a>
            {!ro && (
              <button className="btn-primary" disabled={save.isPending} onClick={submit}>
                {save.isPending ? "Saving…" : "Save settings"}
              </button>
            )}
          </>
        }
      />
      {ro && <Banner kind="info">Only administrators can change organisation settings. Your own sender identity lives under My profile.</Banner>}
      {error && <ErrorBox message={error} />}

      <section className="card space-y-4">
        <h2 className="text-sm font-semibold">Inbox placement</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[14rem_1fr]">
          <Field label="Delivery mode">
            <select className="input" disabled={ro} value={form.deliveryMode} onChange={(e) => set("deliveryMode", e.target.value as DeliveryMode)}>
              <option value="personal">Personal (one-to-one)</option>
              <option value="bulk">Bulk (newsletter)</option>
            </select>
          </Field>
          <div className="text-sm text-gray-600">
            {form.deliveryMode === "personal" ? (
              <>
                <p>
                  Messages are shaped like a hand-written email: no <code>List-Unsubscribe</code> headers, no styled footer, a plain
                  "just reply and let me know" opt-out line. This is what keeps mail out of Gmail's Promotions tab.
                </p>
                <p className="mt-1">
                  <strong>Track opens</strong> below adds a minimal HTML part so SES can insert its open pixel. Turn it off for the
                  cleanest text-only send (opens will then not be measurable; replies and clicks still are).
                </p>
              </>
            ) : (
              <p>
                Classic newsletter shape: styled HTML, grey unsubscribe footer and RFC 8058 one-click unsubscribe headers. Required
                by Gmail/Yahoo for senders above 5,000 messages a day; usually lands in Promotions.
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Reply capture</h2>
        {system.data?.replyCapture.inboundDomain ? (
          <p className="text-sm text-gray-600">
            Replies are received by SES on <code>{system.data.replyCapture.inboundDomain}</code>: campaigns without an explicit Reply-To use{" "}
            <code>&lt;sender&gt;@{system.data.replyCapture.inboundDomain}</code>, and a reply marks the lead as replied and cancels follow-ups within seconds.
          </p>
        ) : (
          <Banner kind="warning">No SES inbound domain is configured; replies are only captured through IMAP polling.</Banner>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={ro} checked={form.forwardRepliesToOwner} onChange={(e) => set("forwardRepliesToOwner", e.target.checked)} />
          Forward replies received by SES to the campaign owner's mailbox (Reply-To set to the lead)
        </label>
        {system.data && (
          <div className="text-xs text-gray-600">
            IMAP mailboxes polled:{" "}
            {system.data.replyCapture.imapAccounts.length === 0
              ? "none (users can add their own under My profile)"
              : system.data.replyCapture.imapAccounts.map((a) => `${a.label}${a.lastError ? " (error)" : ""}`).join(", ")}
          </div>
        )}
      </section>

      <section className="card space-y-4">
        <h2 className="text-sm font-semibold">Sending</h2>
        <p className="text-xs text-gray-500">Defaults for every campaign. A user's own sender identity (My profile) or a campaign override takes precedence.</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="From email" hint="Must be a verified SES identity or on a verified domain">
            <input className="input" type="email" disabled={ro} value={form.fromEmail} onChange={(e) => set("fromEmail", e.target.value)} />
          </Field>
          <Field label="From name">
            <input className="input" disabled={ro} value={form.fromName} onChange={(e) => set("fromName", e.target.value)} />
          </Field>
          <Field label="Reply-to">
            <input className="input" type="email" disabled={ro} value={form.replyTo ?? ""} onChange={(e) => set("replyTo", e.target.value)} />
          </Field>
          <Field label="SES configuration set" hint="Needed for event tracking">
            <input className="input" disabled={ro} value={form.configurationSet ?? ""} onChange={(e) => set("configurationSet", e.target.value)} />
          </Field>
          <Field label="Daily cap (all campaigns)">
            <input className="input" type="number" min={0} disabled={ro} value={form.dailyCap} onChange={(e) => set("dailyCap", num(e.target.value))} />
          </Field>
          <Field label="Max send rate (per second)">
            <input className="input" type="number" min={0.1} step={0.1} disabled={ro} value={form.maxSendRate} onChange={(e) => set("maxSendRate", Number(e.target.value))} />
          </Field>
          <Field label="Default approval mode">
            <select className="input" disabled={ro} value={form.defaultApprovalMode} onChange={(e) => set("defaultApprovalMode", e.target.value as ApprovalMode)}>
              <option value="manual">Manual review</option>
              <option value="auto">Auto-send</option>
            </select>
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={ro} checked={form.trackOpens} onChange={(e) => set("trackOpens", e.target.checked)} /> Track opens
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={ro} checked={form.trackClicks} onChange={(e) => set("trackClicks", e.target.checked)} /> Track clicks
            </label>
          </div>
        </div>
        <Field label="Postal address (printed in the footer)">
          <input className="input" disabled={ro} value={form.postalAddress ?? ""} onChange={(e) => set("postalAddress", e.target.value)} />
        </Field>
      </section>

      <ProviderKeysCard
        providers={catalogue.data?.providers ?? []}
        readOnly={ro}
        focusProvider={keyFocus}
        onFocusHandled={() => setKeyFocus(null)}
      />

      <section className="card space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Models</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Defaults for every campaign. A campaign can override any of these; green rows in the picker run through the
            provider's batch endpoint at half price, with results arriving later instead of immediately.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Research model">
            <ModelSelect
              value={form.researchModel}
              onChange={(v) => set("researchModel", v)}
              catalogue={catalogue.data}
              disabled={ro}
              onAddKey={setKeyFocus}
            />
          </Field>
          <Field label="Drafting model">
            <ModelSelect
              value={form.llmModel}
              onChange={(v) => set("llmModel", v)}
              catalogue={catalogue.data}
              disabled={ro}
              onAddKey={setKeyFocus}
            />
          </Field>
        </div>
        <Field label="Research depth" hint="How hard research digs by default. Each step up costs several times the one below.">
          <ResearchModeSelect
            value={form.researchMode}
            onChange={(v) => set("researchMode", (v || "great") as ResearchMode)}
            catalogue={catalogue.data}
            disabled={ro}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={ro} checked={form.webSearchEnabled} onChange={(e) => set("webSearchEnabled", e.target.checked)} /> Use web
          search in research (only applies to models that support it)
        </label>
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Batching &amp; cost controls</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Applies when a selected model is a batch model. Batch endpoints halve the price but are asynchronous.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Default batch grouping">
            <select className="input" disabled={ro} value={form.batchStrategy} onChange={(e) => set("batchStrategy", e.target.value as BatchStrategy)}>
              {BATCH_STRATEGIES.map((x) => (
                <option key={x} value={x}>
                  {BATCH_STRATEGY_LABELS[x]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Rolling flush window (minutes)" hint="Submit a batch once its oldest queued request is this old.">
            <input
              className="input"
              type="number"
              min={1}
              max={720}
              disabled={ro || form.batchStrategy !== "rolling"}
              value={form.batchFlushMinutes}
              onChange={(e) => set("batchFlushMinutes", num(e.target.value))}
            />
          </Field>
          <Field label="Max requests per batch" hint="A batch is also submitted as soon as it reaches this size.">
            <input className="input" type="number" min={1} max={50000} disabled={ro} value={form.batchMaxRequests} onChange={(e) => set("batchMaxRequests", num(e.target.value))} />
          </Field>
          <Field label="Campaign spend cap (USD)" hint="Refuse to start a campaign projected to cost more than this. 0 disables the check.">
            <input className="input" type="number" min={0} step={1} disabled={ro} value={form.campaignCostCapUsd} onChange={(e) => set("campaignCostCapUsd", Number(e.target.value) || 0)} />
          </Field>
        </div>
      </section>

      <ModelRatesCard
        models={catalogue.data?.models ?? []}
        capturedAt={catalogue.data?.ratesCapturedAt ?? null}
        overrides={form.modelRateOverrides}
        onChange={(v) => set("modelRateOverrides", v)}
        readOnly={ro}
      />

      <section className="card space-y-4">
        <h2 className="text-sm font-semibold">Hard rules (deterministic validator)</h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Field label="Min words">
            <input className="input" type="number" disabled={ro} value={form.hardRules.minWords} onChange={(e) => setRule("minWords", num(e.target.value))} />
          </Field>
          <Field label="Max words">
            <input className="input" type="number" disabled={ro} value={form.hardRules.maxWords} onChange={(e) => setRule("maxWords", num(e.target.value))} />
          </Field>
          <Field label="Max subject chars">
            <input className="input" type="number" disabled={ro} value={form.hardRules.maxSubjectChars} onChange={(e) => setRule("maxSubjectChars", num(e.target.value))} />
          </Field>
          <Field label="Max links">
            <input className="input" type="number" disabled={ro} value={form.hardRules.maxLinks} onChange={(e) => setRule("maxLinks", num(e.target.value))} />
          </Field>
        </div>
        <Field label="Banned phrases">
          <ChipsInput disabled={ro} value={form.hardRules.bannedPhrases} onChange={(v) => setRule("bannedPhrases", v)} />
        </Field>
        <Field label="Required phrases">
          <ChipsInput disabled={ro} value={form.hardRules.requiredPhrases} onChange={(v) => setRule("requiredPhrases", v)} />
        </Field>
        <Field label="Do-not-contact domains">
          <ChipsInput disabled={ro} value={form.hardRules.doNotContactDomains} onChange={(v) => setRule("doNotContactDomains", v)} placeholder="competitor.com" />
        </Field>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          {(
            [
              ["forbidEmojis", "Forbid emojis"],
              ["forbidLinks", "Forbid links"],
              ["forbidExclamation", "Forbid exclamation marks"],
              ["forbidAllCapsWords", "Forbid ALL-CAPS words"],
              ["requireUnsubscribeFooter", "Require unsubscribe footer"],
            ] as Array<[keyof HardRules, string]>
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" disabled={ro} checked={Boolean(form.hardRules[k])} onChange={(e) => setRule(k, e.target.checked as never)} /> {label}
            </label>
          ))}
        </div>
        <h3 className="text-xs font-semibold uppercase text-gray-500">Send window</h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Field label="Start hour (0-23)">
            <input className="input" type="number" min={0} max={23} disabled={ro} value={form.hardRules.sendWindowStartHour} onChange={(e) => setRule("sendWindowStartHour", num(e.target.value))} />
          </Field>
          <Field label="End hour (1-24)">
            <input className="input" type="number" min={1} max={24} disabled={ro} value={form.hardRules.sendWindowEndHour} onChange={(e) => setRule("sendWindowEndHour", num(e.target.value))} />
          </Field>
          <Field label="Timezone (IANA)">
            <input className="input" disabled={ro} value={form.hardRules.timezone} onChange={(e) => setRule("timezone", e.target.value)} placeholder="Asia/Kolkata" />
          </Field>
          <Field label="Send days">
            <div className="flex flex-wrap gap-2 pt-1 text-xs">
              {DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    disabled={ro}
                    checked={form.hardRules.sendDays.includes(i)}
                    onChange={(e) =>
                      setRule("sendDays", e.target.checked ? [...form.hardRules.sendDays, i].sort() : form.hardRules.sendDays.filter((x) => x !== i))
                    }
                  />
                  {d}
                </label>
              ))}
            </div>
          </Field>
        </div>
      </section>
    </div>
  );
}
