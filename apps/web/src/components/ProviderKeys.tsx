import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConfigurableProvider, ProviderStatusDto } from "@mailapp/shared";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useToast } from "../hooks/useToast";
import { Field, Modal } from "./ui";

/**
 * API keys for the model providers.
 *
 * A key entered here is encrypted with APP_SECRET and takes precedence over the environment
 * variable, so keys can be rotated without a redeploy. Keys are never sent back to the
 * browser — only the last four characters, so an operator can tell which key is stored.
 */
export function ProviderKeysCard({
  providers,
  readOnly,
  focusProvider,
  onFocusHandled,
}: {
  providers: ProviderStatusDto[];
  readOnly: boolean;
  /** Set to open the dialog straight onto one provider (from the model picker's "Add key"). */
  focusProvider?: string | null;
  onFocusHandled?: () => void;
}) {
  const [editing, setEditing] = useState<ProviderStatusDto | null>(null);

  useEffect(() => {
    if (!focusProvider) return;
    const match = providers.find((p) => p.provider === focusProvider);
    if (match) setEditing(match);
    onFocusHandled?.();
  }, [focusProvider, providers, onFocusHandled]);

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Model providers</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          A key stored here overrides the environment variable and is used immediately. Models whose provider has no key are
          shown greyed out in every model picker.
        </p>
      </div>
      <div className="space-y-2">
        {providers.map((p) => (
          <ProviderRow key={p.provider} provider={p} readOnly={readOnly} onEdit={() => setEditing(p)} />
        ))}
      </div>
      <ProviderKeyDialog provider={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

function ProviderRow({ provider: p, readOnly, onEdit }: { provider: ProviderStatusDto; readOnly: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string | null }>(`/api/llm/providers/${p.provider}/test`),
    onSuccess: (r) => {
      if (r.ok) toast.success(`${p.label} key works`);
      else toast.error(new Error(r.message ?? "The provider rejected the key"), `${p.label} test failed`);
      qc.invalidateQueries({ queryKey: ["llm"] });
    },
    onError: (e) => toast.error(e, "Test failed"),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/llm/providers/${p.provider}`),
    onSuccess: () => {
      toast.success(`${p.label} key removed`);
      qc.invalidateQueries({ queryKey: ["llm"] });
    },
    onError: (e) => toast.error(e, "Remove failed"),
  });

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-gray-200 px-3 py-2 text-sm">
      <span
        className={
          "inline-block h-2 w-2 shrink-0 rounded-full " + (p.configured ? "bg-emerald-500" : "bg-gray-300")
        }
        aria-hidden
      />
      <span className="font-medium">{p.label}</span>
      <span className="text-xs text-gray-500">
        {p.configured
          ? p.source === "database"
            ? `key ••••${p.keyHint ?? ""} · set ${relativeTime(p.updatedAt)}`
            : `from ${p.envVar}`
          : "no key"}
        {" · "}
        {p.modelCount} model{p.modelCount === 1 ? "" : "s"}
      </span>
      {p.lastTest && (
        <span className={"text-xs " + (p.lastTest.ok ? "text-emerald-700" : "text-red-700")}>
          {p.lastTest.ok ? "verified" : "failed"} {relativeTime(p.lastTest.at)}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1">
        {p.configured && (
          <button className="btn-ghost btn-sm" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Testing…" : "Test"}
          </button>
        )}
        {!readOnly && (
          <button className="btn-secondary btn-sm" onClick={onEdit}>
            {p.source === "database" ? "Replace key" : "Add key"}
          </button>
        )}
        {!readOnly && p.source === "database" && (
          <button className="btn-ghost btn-sm text-red-700" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </button>
        )}
      </span>
    </div>
  );
}

function ProviderKeyDialog({ provider: p, onClose }: { provider: ProviderStatusDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  useEffect(() => {
    setApiKey("");
    setBaseUrl(p?.baseUrl ?? "");
  }, [p]);

  const save = useMutation({
    mutationFn: (body: { apiKey: string; baseUrl?: string }) => api.put(`/api/llm/providers/${p!.provider}`, body),
    onSuccess: () => {
      toast.success(`${p!.label} key saved`);
      qc.invalidateQueries({ queryKey: ["llm"] });
      onClose();
    },
    onError: (e) => toast.error(e, "Save failed"),
  });

  if (!p) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`${p.label} API key`}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || apiKey.trim().length < 8}
            onClick={() => save.mutate({ apiKey: apiKey.trim(), baseUrl: baseUrl.trim() || undefined })}
          >
            {save.isPending ? "Saving…" : "Save key"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="API key" hint={`Create one at ${p.keysUrl}. Stored encrypted; never shown again.`}>
          <input
            className="input font-mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={p.source === "database" ? `replacing ••••${p.keyHint ?? ""}` : "paste the key"}
          />
        </Field>
        <Field label="Base URL (optional)" hint="Only needed for a gateway or a compatible self-hosted endpoint.">
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
        </Field>
        <p className="text-xs text-gray-500">
          The key replaces <code>{p.envVar}</code> for this deployment. Remove it to fall back to the environment.
        </p>
      </div>
    </Modal>
  );
}

export type { ConfigurableProvider };
