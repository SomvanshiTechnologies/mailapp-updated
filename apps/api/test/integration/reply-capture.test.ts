import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestContext, json, loginAs, req, type Session, type TestContext } from "../helpers/context.js";
import { createCampaign, createService, leadRows, rawEmail, snsNotification } from "../helpers/fixtures.js";
import { emails, imapCursors, leads, users } from "../../src/db/schema.js";
import { decryptSecret, encryptSecret } from "../../src/lib/crypto.js";
import { runImapPoll, type ImapAccount, type ImapClientFactory, type ImapClientLike } from "../../src/modules/ses/imap.js";
import { resolveSender } from "../../src/modules/settings/sender.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({ SES_INBOUND_DOMAIN: "reply.example.com" });
});
afterAll(async () => ctx.close());
beforeEach(async () => ctx.reset());

async function sendOne(s: Session) {
  await createService(ctx, s);
  const c = await createCampaign(ctx, s, { rows: leadRows(1), payload: { approvalMode: "auto" } });
  await req(ctx, s, { method: "POST", url: `/api/campaigns/${c.id}/start` });
  await ctx.queue.drain();
  const [email] = await ctx.db.select().from(emails).where(eq(emails.campaignId, c.id));
  const [lead] = await ctx.db.select().from(leads).where(eq(leads.id, email.leadId));
  return { campaign: c, email, lead };
}

/** In-memory IMAP server: a list of raw messages with UIDs; records that no flag calls exist at all. */
function fakeImap(messages: Array<{ uid: number; raw: string; date: Date }>, uidValidity = 1): { factory: ImapClientFactory; calls: string[] } {
  const calls: string[] = [];
  const factory: ImapClientFactory = (account: ImapAccount) => {
    calls.push(`connect:${account.user}`);
    const client: ImapClientLike = {
      mailbox: { uidValidity: BigInt(uidValidity), uidNext: Math.max(0, ...messages.map((m) => m.uid)) + 1 },
      async connect() {},
      async logout() {
        calls.push("logout");
      },
      async getMailboxLock(mailbox) {
        calls.push(`lock:${mailbox}`);
        return { release: () => calls.push("release") };
      },
      async search(query) {
        if (typeof query.uid === "string") {
          const [from] = String(query.uid).split(":");
          return messages.filter((m) => m.uid >= Number(from)).map((m) => m.uid);
        }
        if (query.since instanceof Date) return messages.filter((m) => m.date >= (query.since as Date)).map((m) => m.uid);
        return messages.map((m) => m.uid);
      },
      async fetchOne(uid) {
        const m = messages.find((x) => x.uid === Number(uid));
        return m ? { uid: m.uid, source: Buffer.from(m.raw) } : false;
      },
    };
    return client;
  };
  return { factory, calls };
}

describe("crypto", () => {
  it("round-trips secrets and rejects tampering", () => {
    const enc = encryptSecret("s".repeat(40), "hunter2-password");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain("hunter2");
    expect(decryptSecret("s".repeat(40), enc)).toBe("hunter2-password");
    expect(() => decryptSecret("x".repeat(40), enc)).toThrow();
  });
});

describe("SES inbound domain", () => {
  it("routes Reply-To through the inbound domain unless the campaign or user set one", async () => {
    const admin = await loginAs(ctx, "admin");
    const alice = await loginAs(ctx, "operator", "alice@test.local");
    await req(ctx, alice, { method: "PATCH", url: "/api/auth/me", payload: { fromEmail: "alice@example.com" } });
    expect((await resolveSender(ctx, { createdBy: alice.user.id, fromEmail: null, fromName: null, replyTo: null })).replyTo).toBe("alice@reply.example.com");
    expect((await resolveSender(ctx, { createdBy: admin.user.id, fromEmail: null, fromName: null, replyTo: null })).replyTo).toBe("outreach@reply.example.com");
    expect((await resolveSender(ctx, { createdBy: alice.user.id, fromEmail: null, fromName: null, replyTo: "team@example.com" })).replyTo).toBe("team@example.com");
    await req(ctx, alice, { method: "PATCH", url: "/api/auth/me", payload: { replyTo: "alice@example.com" } });
    expect((await resolveSender(ctx, { createdBy: alice.user.id, fromEmail: null, fromName: null, replyTo: null })).replyTo).toBe("alice@example.com");
    const me = json(await req(ctx, admin, { method: "GET", url: "/api/auth/me" })).user;
    expect(me.effectiveReplyTo).toBe("outreach@reply.example.com");
  });

  it("sends with the capture address and forwards SES-received replies to the owner's mailbox", async () => {
    const alice = await loginAs(ctx, "operator", "alice@test.local");
    await req(ctx, alice, { method: "PATCH", url: "/api/auth/me", payload: { fromEmail: "alice@example.com", fromName: "Alice" } });
    const { email, lead } = await sendOne(alice);
    expect(ctx.ses.sent[0].replyTo).toBe("alice@reply.example.com");

    const raw = rawEmail({ from: `Lead One <${lead.email}>`, to: "alice@reply.example.com", subject: `Re: ${email.subject}`, text: "Sounds good, call me.", inReplyTo: email.messageIdHeader! });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/ses/inbound",
      payload: snsNotification({ notificationType: "Received", mail: { messageId: "inb-1" }, content: Buffer.from(raw).toString("base64") }),
      headers: { "content-type": "text/plain" },
    });
    expect(json(res)).toMatchObject({ matched: true, autoReply: false });
    const [after] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after.status).toBe("replied");
    // Forwarded copy: to Alice's real mailbox, Reply-To the lead, quoting the reply.
    const fwd = ctx.ses.sent.find((m) => m.tags.kind === "reply_forward");
    expect(fwd).toBeTruthy();
    expect(fwd!.to).toBe("alice@example.com");
    expect(fwd!.replyTo).toBe(lead.email);
    expect(fwd!.subject).toBe(`Re: ${email.subject}`);
    expect(fwd!.text).toContain("Sounds good, call me.");
    expect(fwd!.text).toContain(`/leads/${lead.id}`);
    expect(ctx.metrics.totals.replies_forwarded).toBe(1);

    // Forwarding can be switched off.
    const admin = await loginAs(ctx, "admin");
    const settings = json(await req(ctx, admin, { method: "GET", url: "/api/settings" })).settings;
    await req(ctx, admin, { method: "PUT", url: "/api/settings", payload: { ...settings, forwardRepliesToOwner: false, updatedAt: undefined } });
    const raw2 = rawEmail({ from: `Lead One <${lead.email}>`, to: "alice@reply.example.com", subject: "Re: again", text: "second", inReplyTo: email.messageIdHeader! });
    await ctx.app.inject({ method: "POST", url: "/webhooks/ses/inbound", payload: snsNotification({ notificationType: "Received", mail: { messageId: "inb-2" }, content: Buffer.from(raw2).toString("base64") }), headers: { "content-type": "text/plain" } });
    expect(ctx.ses.sent.filter((m) => m.tags.kind === "reply_forward")).toHaveLength(1);
  });
});

describe("per-user IMAP polling", () => {
  it("stores mailbox credentials encrypted, validates completeness and never returns the password", async () => {
    const alice = await loginAs(ctx, "operator", "alice@test.local");
    let r = await req(ctx, alice, { method: "PATCH", url: "/api/auth/me", payload: { imapEnabled: true, imapHost: "imap.hostinger.com", imapUser: "alice@example.com" } });
    expect(r.statusCode).toBe(400);
    expect(json(r).error.message).toMatch(/password/);
    r = await req(ctx, alice, { method: "PATCH", url: "/api/auth/me", payload: { imapEnabled: true, imapHost: "imap.hostinger.com", imapPort: 993, imapUser: "alice@example.com", imapPassword: "mailbox-secret" } });
    expect(r.statusCode).toBe(200);
    expect(json(r).user.imap).toMatchObject({ enabled: true, host: "imap.hostinger.com", user: "alice@example.com", passwordSet: true, mailbox: "INBOX" });
    expect(JSON.stringify(json(r))).not.toContain("mailbox-secret");
    const [row] = await ctx.db.select().from(users).where(eq(users.id, alice.user.id));
    expect(row.imapPasswordEnc).not.toContain("mailbox-secret");
    expect(decryptSecret(ctx.config.APP_SECRET, row.imapPasswordEnc!)).toBe("mailbox-secret");
    // Omitting the password keeps it; the users list hides it too.
    await req(ctx, alice, { method: "PATCH", url: "/api/auth/me", payload: { imapMailbox: "Inbox/Replies" } });
    const me = json(await req(ctx, alice, { method: "GET", url: "/api/auth/me" })).user;
    expect(me.imap).toMatchObject({ passwordSet: true, mailbox: "Inbox/Replies" });
    const admin = await loginAs(ctx, "admin");
    expect(JSON.stringify(json(await req(ctx, admin, { method: "GET", url: "/api/users" })))).not.toContain("mailbox-secret");
    // The connection test reports failures as a 400 rather than a crash.
    r = await req(ctx, alice, { method: "POST", url: "/api/auth/me/imap-test", payload: { imapHost: "127.0.0.1", imapPort: 9, imapUser: "x", imapPassword: "y" } });
    expect(r.statusCode).toBe(400);
    expect(json(r).error.message).toMatch(/IMAP connection failed/);
  });

  it("polls each user's mailbox read-only, matches replies and advances the cursor", async () => {
    const alice = await loginAs(ctx, "operator", "alice@test.local");
    await req(ctx, alice, { method: "PATCH", url: "/api/auth/me", payload: { fromEmail: "alice@example.com", replyTo: "alice@example.com", imapEnabled: true, imapHost: "imap.example.com", imapUser: "alice@example.com", imapPassword: "pw" } });
    const { email, lead } = await sendOne(alice);
    expect(ctx.ses.sent[0].replyTo).toBe("alice@example.com");

    const old = rawEmail({ from: "someone@else.example", to: "alice@example.com", subject: "Old newsletter", text: "ignore", messageId: "<old@x>" });
    const reply = rawEmail({ from: `Lead One <${lead.email}>`, to: "alice@example.com", subject: `Re: ${email.subject}`, text: "Yes please", inReplyTo: email.messageIdHeader!, messageId: "<r1@theirs>" });
    const messages = [
      { uid: 5, raw: old, date: new Date(Date.now() - 10 * 86_400_000) },
      { uid: 6, raw: reply, date: new Date() },
    ];
    const fake = fakeImap(messages);
    let result = await runImapPoll(ctx, fake.factory);
    expect(result).toEqual({ processed: 1, accounts: 1, errors: 0 }); // the 10-day-old message is outside the initial lookback
    const [after] = await ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after.status).toBe("replied");
    expect(ctx.ses.sent.filter((m) => m.tags.kind === "reply_forward")).toHaveLength(0); // already in her inbox
    let [cursor] = await ctx.db.select().from(imapCursors).where(eq(imapCursors.accountKey, `user:${alice.user.id}`));
    expect(cursor).toMatchObject({ lastUid: 6, uidValidity: "1", lastError: null });
    expect(fake.calls).toEqual(["connect:alice@example.com", "lock:INBOX", "release", "logout"]);

    // Second poll: only UIDs above the cursor are read; nothing new → nothing processed.
    result = await runImapPoll(ctx, fake.factory);
    expect(result.processed).toBe(0);
    messages.push({ uid: 7, raw: rawEmail({ from: `Lead One <${lead.email}>`, to: "alice@example.com", subject: "Re: more", text: "follow-up answer", inReplyTo: email.messageIdHeader!, messageId: "<r2@theirs>" }), date: new Date() });
    result = await runImapPoll(ctx, fake.factory);
    expect(result.processed).toBe(1);
    [cursor] = await ctx.db.select().from(imapCursors).where(eq(imapCursors.accountKey, `user:${alice.user.id}`));
    expect(cursor.lastUid).toBe(7);
    const thread = await ctx.db.select().from(emails).where(eq(emails.leadId, lead.id));
    expect(thread.filter((e) => e.direction === "inbound")).toHaveLength(2);

    // Connection failures are recorded per account and do not stop the poll.
    const failing: ImapClientFactory = () => ({
      mailbox: false,
      async connect() {
        throw new Error("AUTHENTICATIONFAILED");
      },
      async logout() {},
      async getMailboxLock() {
        return { release() {} };
      },
      async search() {
        return [];
      },
      async fetchOne() {
        return false;
      },
    });
    result = await runImapPoll(ctx, failing);
    expect(result).toEqual({ processed: 0, accounts: 1, errors: 1 });
    const me = json(await req(ctx, alice, { method: "GET", url: "/api/auth/me" })).user;
    expect(me.imap.lastError).toContain("AUTHENTICATIONFAILED");
    const status = json(await req(ctx, alice, { method: "GET", url: "/api/system/status" }));
    expect(status.replyCapture).toMatchObject({ inboundDomain: "reply.example.com" });
    expect(status.replyCapture.imapAccounts[0]).toMatchObject({ key: `user:${alice.user.id}`, lastError: expect.stringContaining("AUTHENTICATIONFAILED") });

    // Disabled mailboxes are skipped.
    await req(ctx, alice, { method: "PATCH", url: "/api/auth/me", payload: { imapEnabled: false } });
    expect((await runImapPoll(ctx, fake.factory)).accounts).toBe(0);
  });
});
