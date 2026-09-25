import * as cheerio from "cheerio";
import type { WebsiteExtract } from "../llm/provider.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 6000;
const UA = "Mozilla/5.0 (compatible; OutreachEngine/1.0; +https://example.com/bot)";

export function normaliseWebsiteUrl(raw: string | null | undefined, email?: string | null): string | null {
  let v = (raw ?? "").trim();
  if (!v && email) {
    const domain = email.split("@")[1];
    if (domain && !GENERIC_DOMAINS.has(domain.toLowerCase())) v = domain;
  }
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const GENERIC_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "me.com",
  "msn.com",
  "example.com",
]);

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

/** Fetch a page and extract readable text. Returns null on any failure; never throws. */
export async function fetchWebsiteExtract(
  url: string,
  opts: { timeoutMs?: number; fetcher?: Fetcher } = {},
): Promise<WebsiteExtract | null> {
  const fetcher = opts.fetcher ?? ((u, init) => fetch(u, { ...init, redirect: "follow" }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 12_000);
  try {
    const res = await fetcher(url, {
      signal: controller.signal,
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("text")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const html = buf.subarray(0, MAX_BYTES).toString("utf8");
    return extractFromHtml(html, res.url || url);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function extractFromHtml(html: string, url: string): WebsiteExtract {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, nav, footer, header, form").remove();
  const title = ($("title").first().text() || $("meta[property='og:title']").attr("content") || "").trim();
  const description = (
    $("meta[name='description']").attr("content") ||
    $("meta[property='og:description']").attr("content") ||
    ""
  ).trim();
  const headings: string[] = [];
  $("h1, h2, h3").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length < 160 && !headings.includes(t)) headings.push(t);
  });
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return { url, title, description, headings: headings.slice(0, 40), text, fetchedAt: new Date().toISOString() };
}
