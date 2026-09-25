import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LandingPageSchema, type LandingPage, type LandingService, type ServiceDto, type SettingsDto } from "@mailapp/shared";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { Banner, ErrorBox, Field, PageHeader, Spinner } from "../components/ui";

/**
 * Editor for the public page behind the small link at the bottom of every email: which
 * services appear (with link / contact buttons), the wording, and whether the unsubscribe
 * button is shown. The right-hand pane previews the page exactly as recipients see it.
 */
export function LandingPagePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { isAdmin } = useAuth();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: SettingsDto }>("/api/settings") });
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.get<{ items: ServiceDto[] }>("/api/services") });
  const [form, setForm] = useState<LandingPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>("");

  useEffect(() => {
    if (settings.data && services.data && !form) {
      const cfg = settings.data.settings.landingPage;
      // An empty list means "every active service with default buttons": materialise it so each row is editable.
      const rows: LandingService[] = cfg.services.length
        ? cfg.services
        : services.data.items.filter((s) => s.isActive).map((s) => ({ serviceId: s.id, showLink: true, showContact: true, contactUrl: "" }));
      setForm({ ...cfg, services: rows });
    }
  }, [settings.data, services.data, form]);

  // Live preview, debounced.
  useEffect(() => {
    if (!form) return;
    const parsed = LandingPageSchema.safeParse(form);
    if (!parsed.success) return;
    const t = setTimeout(() => {
      api
        .post<string>("/api/settings/landing/preview", parsed.data)
        .then((html) => setPreview(html))
        .catch((e) => setPreview(`<p style="font-family:sans-serif;color:#991b1b">${errorMessage(e)}</p>`));
    }, 400);
    return () => clearTimeout(t);
  }, [form]);

  const save = useMutation({
    mutationFn: (body: LandingPage) => api.put<{ landingPage: LandingPage }>("/api/settings/landing", body),
    onSuccess: () => {
      toast.success("Link page saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => toast.error(e, "Save failed"),
  });

  const activeServices = useMemo(() => (services.data?.items ?? []).filter((s) => s.isActive), [services.data]);
  if (settings.isLoading || services.isLoading || !form) return <Spinner />;
  if (settings.error) return <ErrorBox message={(settings.error as Error).message} />;
  const ro = !isAdmin;
  const set = <K extends keyof LandingPage>(k: K, v: LandingPage[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const included = new Map(form.services.map((s, i) => [s.serviceId, i]));
  const toggleService = (id: string, on: boolean) =>
    set("services", on ? [...form.services, { serviceId: id, showLink: true, showContact: true, contactUrl: "" }] : form.services.filter((s) => s.serviceId !== id));
  const setService = (id: string, patch: Partial<LandingService>) => set("services", form.services.map((s) => (s.serviceId === id ? { ...s, ...patch } : s)));
  const move = (id: string, dir: -1 | 1) => {
    const i = included.get(id);
    if (i === undefined) return;
    const j = i + dir;
    if (j < 0 || j >= form.services.length) return;
    const next = [...form.services];
    [next[i], next[j]] = [next[j], next[i]];
    set("services", next);
  };
  const submit = () => {
    setError(null);
    const parsed = LandingPageSchema.safeParse(form);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(`${i.path.join(".")}: ${i.message}`);
      return;
    }
    save.mutate(parsed.data);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Manage link page"
        subtitle={
          <>
            The page recipients see when they click the "{form.emailLinkLabel}" link at the bottom of an email. Services come from the{" "}
            <Link to="/services" className="text-brand-700 hover:underline">
              catalogue
            </Link>
            .
          </>
        }
        actions={
          !ro && (
            <button className="btn-primary" disabled={save.isPending} onClick={submit}>
              {save.isPending ? "Saving…" : "Save link page"}
            </button>
          )
        }
      />
      {ro && <Banner kind="info">Only administrators can change the link page. You are viewing it read-only.</Banner>}
      {!form.showUnsubscribe && (
        <Banner kind="warning">
          The unsubscribe button is hidden. Anti-spam rules (CAN-SPAM, GDPR) still require a working way to opt out, so keep it hidden only
          if recipients can opt out another way (for example by replying). One-click unsubscribe from mail clients keeps working regardless.
        </Banner>
      )}
      {error && <ErrorBox message={error} />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <section className="card space-y-4">
            <h2 className="text-sm font-semibold">Wording</h2>
            <Field label="Link text in emails" hint="Replaces the long URL with a small link (HTML part). Plain-text parts still show the URL.">
              <input className="input" disabled={ro} value={form.emailLinkLabel} onChange={(e) => set("emailLinkLabel", e.target.value)} />
            </Field>
            <Field label="Headline">
              <input className="input" disabled={ro} value={form.headline} onChange={(e) => set("headline", e.target.value)} />
            </Field>
            <Field label="Intro">
              <textarea className="input" rows={3} disabled={ro} value={form.intro} onChange={(e) => set("intro", e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Link button label">
                <input className="input" disabled={ro} value={form.linkLabel} onChange={(e) => set("linkLabel", e.target.value)} />
              </Field>
              <Field label="Contact button label">
                <input className="input" disabled={ro} value={form.contactLabel} onChange={(e) => set("contactLabel", e.target.value)} />
              </Field>
              <Field label="Contact email" hint="Default target of contact buttons (mailto)">
                <input className="input" type="email" disabled={ro} value={form.contactEmail ?? ""} onChange={(e) => set("contactEmail", e.target.value)} />
              </Field>
            </div>
            <Field label="Footer note" hint="Shown at the bottom left; blank = organisation from-name">
              <input className="input" disabled={ro} value={form.footerNote} onChange={(e) => set("footerNote", e.target.value)} />
            </Field>
          </section>

          <section className="card space-y-3">
            <h2 className="text-sm font-semibold">Unsubscribe button</h2>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" disabled={ro} checked={form.showUnsubscribe} onChange={(e) => set("showUnsubscribe", e.target.checked)} /> Show a small unsubscribe button on the page
            </label>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Button label">
                <input className="input" disabled={ro || !form.showUnsubscribe} value={form.unsubscribeLabel} onChange={(e) => set("unsubscribeLabel", e.target.value)} />
              </Field>
              <Field label="Note next to it">
                <input className="input" disabled={ro || !form.showUnsubscribe} value={form.unsubscribeNote} onChange={(e) => set("unsubscribeNote", e.target.value)} />
              </Field>
            </div>
          </section>

          <section className="card space-y-3">
            <h2 className="text-sm font-semibold">Services on the page</h2>
            {activeServices.length === 0 ? (
              <p className="text-sm text-gray-500">No active services in the catalogue yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Show</th>
                    <th>Service</th>
                    <th>Link button</th>
                    <th>Contact button</th>
                    <th>Contact target (optional)</th>
                    <th>Order</th>
                  </tr>
                </thead>
                <tbody>
                  {[...activeServices]
                    .sort((a, b) => (included.get(a.id) ?? 999) - (included.get(b.id) ?? 999))
                    .map((s) => {
                      const row = form.services.find((x) => x.serviceId === s.id);
                      return (
                        <tr key={s.id} className={row ? "" : "opacity-60"}>
                          <td>
                            <input type="checkbox" disabled={ro} checked={!!row} onChange={(e) => toggleService(s.id, e.target.checked)} />
                          </td>
                          <td>
                            <div className="font-medium">{s.name}</div>
                            <div className="max-w-[16rem] truncate text-xs text-gray-500" title={s.url || "no url set on the service"}>
                              {s.url || <span className="text-amber-700">no URL on the service</span>}
                            </div>
                          </td>
                          <td>
                            <input type="checkbox" disabled={ro || !row} checked={row?.showLink ?? false} onChange={(e) => setService(s.id, { showLink: e.target.checked })} />
                          </td>
                          <td>
                            <input type="checkbox" disabled={ro || !row} checked={row?.showContact ?? false} onChange={(e) => setService(s.id, { showContact: e.target.checked })} />
                          </td>
                          <td>
                            <input
                              className="input"
                              disabled={ro || !row || !row.showContact}
                              placeholder={form.contactEmail ? `mailto:${form.contactEmail}` : "https://… or mailto:…"}
                              value={row?.contactUrl ?? ""}
                              onChange={(e) => setService(s.id, { contactUrl: e.target.value })}
                            />
                          </td>
                          <td className="whitespace-nowrap">
                            <button className="btn-ghost btn-sm" disabled={ro || !row} onClick={() => move(s.id, -1)} aria-label="Move up">
                              ↑
                            </button>
                            <button className="btn-ghost btn-sm" disabled={ro || !row} onClick={() => move(s.id, 1)} aria-label="Move down">
                              ↓
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <div className="card p-0">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2 text-xs text-gray-500">
            <span>Preview (what a recipient sees after clicking the link)</span>
            <span>updates as you type</span>
          </div>
          {preview ? (
            <iframe title="Link page preview" srcDoc={preview} className="h-[80vh] w-full rounded-b-lg bg-white" sandbox="" />
          ) : (
            <Spinner label="Rendering preview…" />
          )}
        </div>
      </div>
    </div>
  );
}
