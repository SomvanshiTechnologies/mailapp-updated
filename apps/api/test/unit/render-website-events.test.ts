import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { renderEmail } from "../../src/modules/pipeline/render.js";
import { extractFromHtml, fetchWebsiteExtract, normaliseWebsiteUrl } from "../../src/modules/pipeline/website.js";
import { normaliseEventType } from "../../src/modules/ses/events.js";
import { parsedMailToInbound } from "../../src/modules/ses/inbound.js";
import { rawEmail } from "../helpers/fixtures.js";

describe("renderEmail", () => {
  const base = {
    bodyText: "Hi Ann,\n\nSee https://example.com for details.",
    signature: "Best,\nSam",
    senderName: "Sam",
    unsubscribeUrl: "http://localhost:4000/u/tok",
    postalAddress: "1 Main St, Springfield",
    includeUnsubscribeFooter: true,
  };

  it("bulk mode: styled html, grey footer and List-Unsubscribe headers", () => {
    const r = renderEmail({ ...base, deliveryMode: "bulk", htmlPart: true });
    expect(r.text).toContain("Best,\nSam");
    expect(r.text).toContain("unsubscribe here: http://localhost:4000/u/tok");
    expect(r.text).toContain("1 Main St");
    expect(r.html).toContain('<a href="https://example.com"');
    expect(r.html).toContain('href="http://localhost:4000/u/tok"');
    expect(r.html).toContain(">Manage preferences</a>");
    expect(r.html).toContain("style=");
    expect(r.html).not.toContain("<script");
    expect(r.headers["List-Unsubscribe"]).toBe("<http://localhost:4000/u/tok>");
    expect(r.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("personal mode: plain text, human opt-out line, no bulk headers, html only when asked", () => {
    const textOnly = renderEmail({ ...base, deliveryMode: "personal", htmlPart: false });
    expect(textOnly.html).toBeNull();
    expect(textOnly.headers).toEqual({});
    expect(textOnly.text).toContain("just reply and let me know. Manage preferences: http://localhost:4000/u/tok");
    expect(textOnly.text).toContain("1 Main St");
    expect(textOnly.text).not.toContain("unsubscribe here");

    const withHtml = renderEmail({ ...base, deliveryMode: "personal", htmlPart: true, linkLabel: "Our services & preferences" });
    expect(withHtml.html).toContain("<p>");
    expect(withHtml.html).not.toContain("style=");
    expect(withHtml.html).not.toContain("<!doctype");
    // The long URL is hidden behind one small link in the HTML part.
    expect(withHtml.html).toContain('<a href="http://localhost:4000/u/tok">Our services &amp; preferences</a>');
    expect(withHtml.html!.match(/localhost:4000\/u\/tok/g)).toHaveLength(1);
    expect(withHtml.headers).toEqual({});

    const noLink = renderEmail({ ...base, deliveryMode: "personal", htmlPart: false, includeUnsubscribeFooter: false });
    expect(noLink.text).toContain("just reply and let me know and I won't follow up.");
    expect(noLink.text).not.toContain("/u/tok");
  });

  it("escapes html and can omit the footer", () => {
    const r = renderEmail({ bodyText: "<b>hi</b>", signature: "", senderName: "Sam", unsubscribeUrl: "u", postalAddress: "", includeUnsubscribeFooter: false, deliveryMode: "bulk", htmlPart: true });
    expect(r.html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(r.text).not.toContain("unsubscribe");
    expect(r.text.trim().endsWith("Sam")).toBe(true);
  });
});

describe("website extraction", () => {
  it("normalises urls and skips generic email domains", () => {
    expect(normaliseWebsiteUrl("acme.com")).toBe("https://acme.com/");
    expect(normaliseWebsiteUrl(" http://acme.com/about ")).toBe("http://acme.com/about");
    expect(normaliseWebsiteUrl("", "x@gmail.com")).toBeNull();
    expect(normaliseWebsiteUrl("", "x@acme.io")).toBe("https://acme.io/");
    expect(normaliseWebsiteUrl("localhost")).toBeNull();
  });

  it("extracts title, description, headings and text", () => {
    const html = `<html><head><title>Acme Ltd</title><meta name="description" content="We move boxes"></head>
      <body><nav>Menu</nav><h1>Logistics done right</h1><script>alert(1)</script><p>Acme delivers  parcels.</p><h2>Services</h2></body></html>`;
    const e = extractFromHtml(html, "https://acme.com");
    expect(e.title).toBe("Acme Ltd");
    expect(e.description).toBe("We move boxes");
    expect(e.headings).toEqual(["Logistics done right", "Services"]);
    expect(e.text).toContain("Acme delivers parcels.");
    expect(e.text).not.toContain("alert");
    expect(e.text).not.toContain("Menu");
  });

  it("uses the injected fetcher and swallows failures", async () => {
    const ok = await fetchWebsiteExtract("https://acme.com", {
      fetcher: async () => new Response("<html><title>T</title><body>Body</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(ok?.title).toBe("T");
    const bad = await fetchWebsiteExtract("https://acme.com", { fetcher: async () => new Response("x", { status: 500 }) });
    expect(bad).toBeNull();
    const thrown = await fetchWebsiteExtract("https://acme.com", {
      fetcher: async () => {
        throw new Error("network");
      },
    });
    expect(thrown).toBeNull();
  });
});

describe("SES event + inbound parsing", () => {
  it("normalises event types from both notification styles", () => {
    expect(normaliseEventType({ eventType: "Bounce" })).toBe("Bounce");
    expect(normaliseEventType({ notificationType: "Complaint" })).toBe("Complaint");
    expect(normaliseEventType({ eventType: "delivery" })).toBe("Delivery");
    expect(normaliseEventType({ eventType: "Nope" })).toBeNull();
  });

  it("parses replies and detects auto-replies", async () => {
    const reply = await simpleParser(rawEmail({ from: "Ann <ann@acme.com>", to: "outreach@example.com", subject: "Re: hello", text: "Sure, let's talk", inReplyTo: "<abc@email.amazonses.com>", references: "<abc@email.amazonses.com>" }));
    const p = parsedMailToInbound(reply, "ext-1");
    expect(p.from).toBe("ann@acme.com");
    expect(p.inReplyTo).toBe("<abc@email.amazonses.com>");
    expect(p.references).toEqual(["<abc@email.amazonses.com>"]);
    expect(p.isAutoReply).toBe(false);
    expect(p.text).toContain("Sure");

    const ooo = await simpleParser(rawEmail({ from: "ann@acme.com", to: "outreach@example.com", subject: "Automatic reply: hello", text: "I am away" }));
    expect(parsedMailToInbound(ooo, "ext-2").isAutoReply).toBe(true);
    const autoSubmitted = await simpleParser(rawEmail({ from: "ann@acme.com", to: "outreach@example.com", subject: "hello", text: "x", extraHeaders: "Auto-Submitted: auto-replied" }));
    expect(parsedMailToInbound(autoSubmitted, "ext-3").isAutoReply).toBe(true);
  });
});
