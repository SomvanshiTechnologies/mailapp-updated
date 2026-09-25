import type { DeliveryMode } from "@mailapp/shared";

export interface RenderInput {
  bodyText: string;
  signature: string;
  senderName: string;
  unsubscribeUrl: string;
  postalAddress: string;
  /** Hard rule: an opt-out link must appear in the message. */
  includeUnsubscribeFooter: boolean;
  /** Text of the small link that points at the preferences page (HTML parts only). */
  linkLabel?: string;
  /** personal = hand-written one-to-one shape; bulk = newsletter shape. */
  deliveryMode: DeliveryMode;
  /**
   * personal mode only: also send a minimal HTML mirror. SES can only add its open-tracking
   * pixel to an HTML part, so this is what "track opens" costs in inbox-placement terms.
   */
  htmlPart: boolean;
}

export interface RenderedEmail {
  text: string;
  /** null = text-only message. */
  html: string | null;
  /** Extra RFC 5322 headers the delivery mode calls for (List-Unsubscribe in bulk mode). */
  headers: Record<string, string>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function linkify(escaped: string, style = ""): string {
  const attr = style ? ` style="${style}"` : "";
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, (m) => `<a href="${m}"${attr}>${m}</a>`);
}

const paragraphsOf = (text: string) => text.trim().split(/\n{2,}/);

/**
 * Personal mode. Reads like an email a person typed: body, signature, one human opt-out
 * sentence, postal address on its own line. No List-Unsubscribe headers, no styled footer,
 * optional unstyled HTML mirror.
 */
function renderPersonal(input: RenderInput): RenderedEmail {
  const signature = input.signature.trim() || input.senderName;
  const label = input.linkLabel?.trim() || "Manage preferences";
  // Plain text has no buttons: the URL has to be spelled out there.
  const optOutText = input.includeUnsubscribeFooter
    ? `If this isn't relevant, just reply and let me know. ${label}: ${input.unsubscribeUrl}`
    : "If this isn't relevant, just reply and let me know and I won't follow up.";
  const footerLines = [optOutText, input.postalAddress.trim()].filter(Boolean);
  const text = [input.bodyText.trim(), signature, footerLines.join("\n")].filter(Boolean).join("\n\n");

  let html: string | null = null;
  if (input.htmlPart) {
    const para = (p: string) => `<p>${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`;
    // In HTML the long URL becomes one small link.
    const optOutHtml = input.includeUnsubscribeFooter
      ? `<p><small>If this isn't relevant, just reply and let me know. <a href="${escapeHtml(input.unsubscribeUrl)}">${escapeHtml(label)}</a></small></p>`
      : `<p><small>If this isn't relevant, just reply and let me know and I won't follow up.</small></p>`;
    const addressHtml = input.postalAddress.trim() ? `<p><small>${escapeHtml(input.postalAddress.trim())}</small></p>` : "";
    const parts = [...paragraphsOf(input.bodyText).map(para), para(signature), optOutHtml, addressHtml];
    html = `<html><body>${parts.join("")}</body></html>`;
  }
  return { text, html, headers: {} };
}

/** Bulk mode: styled HTML, grey compliance footer, one-click unsubscribe headers. */
function renderBulk(input: RenderInput): RenderedEmail {
  const signature = input.signature.trim() || input.senderName;
  const label = input.linkLabel?.trim() || "Manage preferences";
  const footerLines: string[] = [];
  if (input.includeUnsubscribeFooter) {
    footerLines.push(`If you'd rather not hear from us, you can unsubscribe here: ${input.unsubscribeUrl}`);
  }
  if (input.postalAddress.trim()) footerLines.push(input.postalAddress.trim());

  const text = [input.bodyText.trim(), signature, footerLines.length ? footerLines.join("\n") : ""]
    .filter(Boolean)
    .join("\n\n");

  const paragraphs = paragraphsOf(input.bodyText)
    .map((p) => `<p style="margin:0 0 1em 0">${linkify(escapeHtml(p), "color:#1a56db").replace(/\n/g, "<br>")}</p>`)
    .join("");
  const sigHtml = `<p style="margin:0 0 1em 0">${escapeHtml(signature).replace(/\n/g, "<br>")}</p>`;
  const footerHtml = footerLines.length
    ? `<p style="margin:2em 0 0 0;font-size:12px;color:#6b7280">${footerLines
        .map((l) =>
          input.includeUnsubscribeFooter && l.includes(input.unsubscribeUrl)
            ? `<a href="${escapeHtml(input.unsubscribeUrl)}" style="display:inline-block;padding:4px 10px;border:1px solid #d1d5db;border-radius:6px;color:#6b7280;text-decoration:none;font-size:12px">${escapeHtml(label)}</a>`
            : escapeHtml(l),
        )
        .join("<br>")}</p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111827;max-width:640px">${paragraphs}${sigHtml}${footerHtml}</body></html>`;
  return {
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** Produce the final text/HTML bodies and delivery-mode headers. */
export function renderEmail(input: RenderInput): RenderedEmail {
  return input.deliveryMode === "bulk" ? renderBulk(input) : renderPersonal(input);
}
