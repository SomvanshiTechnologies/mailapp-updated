import type { LandingPage } from "@mailapp/shared";
import type { ServiceRow } from "../../db/schema.js";

export type LandingState =
  | { kind: "active"; email: string }
  | { kind: "unsubscribed"; email: string }
  | { kind: "resubscribed"; email: string }
  | { kind: "invalid" }
  | { kind: "preview"; email: string };

export interface LandingRenderInput {
  config: LandingPage;
  /** Active services in the catalogue; the config decides which are shown and how. */
  services: ServiceRow[];
  state: LandingState;
  /** Where the unsubscribe form posts (the /u/<token> URL). */
  unsubscribeUrl: string;
  /** Organisation name for the page title / footer. */
  orgName: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const safeHref = (url: string): string | null => {
  const u = url.trim();
  if (!u) return null;
  if (/^mailto:/i.test(u) || /^https?:\/\//i.test(u)) return u;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(u)) return `https://${u}`;
  return null;
};

/** Which services to show, in the configured order, merged with per-service display options. */
export function selectLandingServices(config: LandingPage, services: ServiceRow[]) {
  const byId = new Map(services.filter((s) => s.isActive).map((s) => [s.id, s]));
  if (!config.services.length) {
    return [...byId.values()].map((s) => ({ service: s, showLink: true, showContact: true, contactUrl: "" }));
  }
  return config.services
    .map((c) => {
      const service = byId.get(c.serviceId);
      return service ? { service, showLink: c.showLink, showContact: c.showContact, contactUrl: c.contactUrl ?? "" } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

const CSS = `
:root{color-scheme:light}
body{margin:0;background:#f7f7f8;color:#111827;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.55}
.wrap{max-width:680px;margin:0 auto;padding:40px 20px 56px}
h1{font-size:26px;margin:0 0 8px}
.intro{color:#374151;margin:0 0 28px;white-space:pre-wrap}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px 22px;margin:0 0 14px}
.card h2{font-size:18px;margin:0 0 6px}
.card p{margin:0 0 10px;color:#374151}
.card ul{margin:0 0 12px;padding-left:18px;color:#374151}
.btns{display:flex;flex-wrap:wrap;gap:8px}
.btn{display:inline-block;padding:8px 14px;border-radius:8px;font-size:14px;text-decoration:none;border:1px solid #111827}
.btn.primary{background:#111827;color:#fff}
.btn.ghost{background:#fff;color:#111827}
.notice{background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:12px 16px;margin:0 0 20px;color:#065f46}
.foot{margin-top:28px;padding-top:18px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.unsub{display:inline-block;padding:5px 10px;border-radius:6px;font-size:12px;border:1px solid #d1d5db;background:#fff;color:#6b7280;cursor:pointer}
.unsub:hover{color:#111827;border-color:#9ca3af}
.confirm{display:none;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-top:10px;font-size:14px;color:#111827}
.confirm.open{display:block}
.confirm .btns{margin-top:10px}
.btn.small{padding:6px 12px;font-size:13px}
.resub{display:inline-block;padding:8px 14px;border-radius:8px;font-size:14px;border:1px solid #111827;background:#111827;color:#fff;cursor:pointer}
.preview{background:#fef3c7;color:#92400e;font-size:12px;padding:6px 10px;border-radius:6px;margin-bottom:16px;display:inline-block}
`;

/** Toggle the "are you sure?" box without any dependency; the form still works with scripts off (it just submits). */
const SCRIPT = `<script>
(function(){var b=document.getElementById('unsub-btn'),c=document.getElementById('unsub-confirm'),n=document.getElementById('unsub-no');
if(!b||!c)return;b.addEventListener('click',function(e){e.preventDefault();c.classList.add('open');b.style.display='none';});
if(n)n.addEventListener('click',function(e){e.preventDefault();c.classList.remove('open');b.style.display='';});})();
</script>`;

/** The public preferences page. Pure function: no I/O, safe to call for previews. */
export function renderLandingPage(input: LandingRenderInput): string {
  const { config, state } = input;
  const items = selectLandingServices(config, input.services);
  const contactMail = config.contactEmail ? `mailto:${config.contactEmail}` : null;

  const cards = items
    .map(({ service: s, showLink, showContact, contactUrl }) => {
      const link = showLink ? safeHref(s.url) : null;
      const contact = showContact ? safeHref(contactUrl) ?? (contactMail ? `${contactMail}?subject=${encodeURIComponent(`Question about ${s.name}`)}` : null) : null;
      const props = s.valueProps.slice(0, 3).map((p) => `<li>${esc(p)}</li>`).join("");
      const btns = [
        link ? `<a class="btn primary" href="${esc(link)}">${esc(config.linkLabel)}</a>` : "",
        contact ? `<a class="btn ghost" href="${esc(contact)}">${esc(config.contactLabel)}</a>` : "",
      ].join("");
      return `<section class="card"><h2>${esc(s.name)}</h2><p>${esc(s.description)}</p>${props ? `<ul>${props}</ul>` : ""}${btns ? `<div class="btns">${btns}</div>` : ""}</section>`;
    })
    .join("");

  const resubscribeUrl = `${input.unsubscribeUrl}/resubscribe`;
  let notice = "";
  if (state.kind === "unsubscribed") {
    notice = `<div class="notice"><strong>${esc(state.email)}</strong> is unsubscribed and will not receive further emails from us.<div class="btns" style="margin-top:10px"><form method="post" action="${esc(resubscribeUrl)}" style="margin:0"><button class="resub" type="submit">Subscribe again</button></form></div></div>`;
  }
  if (state.kind === "resubscribed") notice = `<div class="notice">Welcome back. <strong>${esc(state.email)}</strong> is subscribed again.</div>`;
  if (state.kind === "invalid") notice = `<div class="notice" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">This link is not valid or has expired.</div>`;
  if (state.kind === "preview") notice = `<span class="preview">Preview: this is how recipients see the page (buttons are disabled here)</span>`;

  const canUnsubscribe = config.showUnsubscribe && (state.kind === "active" || state.kind === "resubscribed" || state.kind === "preview");
  const disabled = state.kind === "preview" ? " disabled" : "";
  const unsubscribe = canUnsubscribe
    ? `<div><button id="unsub-btn" class="unsub" type="button"${disabled}>${esc(config.unsubscribeLabel)}</button>` +
      `<div id="unsub-confirm" class="confirm"><strong>Do you really want to leave us?</strong><div>You will not receive any further emails from us.</div>` +
      `<div class="btns"><form method="post" action="${esc(input.unsubscribeUrl)}" style="margin:0"><button class="btn primary small" type="submit"${disabled}>Yes, unsubscribe</button></form>` +
      `<button id="unsub-no" class="btn ghost small" type="button">No, stay</button></div></div></div>`
    : "";
  const footLeft = [
    config.footerNote ? esc(config.footerNote) : esc(input.orgName),
    canUnsubscribe && config.unsubscribeNote ? `<div>${esc(config.unsubscribeNote)}</div>` : "",
  ]
    .filter(Boolean)
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(input.orgName)}</title><style>${CSS}</style></head><body><div class="wrap">${notice}<h1>${esc(config.headline)}</h1>${config.intro ? `<p class="intro">${esc(config.intro)}</p>` : ""}${cards || `<p class="intro">We have not published any services yet.</p>`}<div class="foot"><div>${footLeft}</div>${unsubscribe}</div></div>${canUnsubscribe ? SCRIPT : ""}</body></html>`;
}
