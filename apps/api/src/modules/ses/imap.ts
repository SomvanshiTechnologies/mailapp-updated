import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { eq } from "drizzle-orm";
import type { AppContext } from "../../context.js";
import { imapCursors, users } from "../../db/schema.js";
import { decryptSecret } from "../../lib/crypto.js";
import { parsedMailToInbound, recordInbound } from "./inbound.js";

/** One mailbox to poll. `key` identifies its cursor row. */
export interface ImapAccount {
  key: string;
  label: string;
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
}

/** The slice of the ImapFlow client we use, so tests can substitute a fake. */
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  /** Populated after the mailbox is opened. */
  mailbox: { uidValidity?: bigint | number; uidNext?: number } | boolean;
  search(query: Record<string, unknown>, opts: { uid: true }): Promise<number[] | false>;
  fetchOne(uid: number | string, query: { source: true }, opts: { uid: true }): Promise<{ uid: number; source?: Buffer } | false>;
}
export type ImapClientFactory = (account: ImapAccount) => ImapClientLike;

const defaultFactory: ImapClientFactory = (a) =>
  new ImapFlow({
    host: a.host,
    port: a.port,
    secure: a.port === 993,
    auth: { user: a.user, pass: a.password },
    logger: false,
  }) as unknown as ImapClientLike;

/** On first contact with a mailbox, only messages this recent are considered. */
const INITIAL_LOOKBACK_MS = 3 * 86_400_000;

/** Organisation mailbox from the environment (optional) plus every user's enabled personal mailbox. */
export async function listImapAccounts(ctx: AppContext): Promise<ImapAccount[]> {
  const c = ctx.config;
  const out: ImapAccount[] = [];
  if (c.IMAP_ENABLED && c.IMAP_HOST && c.IMAP_USER) {
    out.push({ key: "env", label: `${c.IMAP_USER} (organisation)`, host: c.IMAP_HOST, port: c.IMAP_PORT, user: c.IMAP_USER, password: c.IMAP_PASSWORD, mailbox: c.IMAP_MAILBOX });
  }
  const rows = await ctx.db.select().from(users).where(eq(users.imapEnabled, true));
  for (const u of rows) {
    if (!u.isActive || !u.imapHost || !u.imapUser || !u.imapPasswordEnc) continue;
    let password: string;
    try {
      password = decryptSecret(c.APP_SECRET, u.imapPasswordEnc);
    } catch (err) {
      ctx.logger.warn({ err, userId: u.id }, "cannot decrypt IMAP password; skipping account");
      continue;
    }
    out.push({ key: `user:${u.id}`, label: `${u.imapUser} (${u.name})`, host: u.imapHost, port: u.imapPort, user: u.imapUser, password, mailbox: u.imapMailbox || "INBOX" });
  }
  return out;
}

function uidValidityOf(client: ImapClientLike): string | null {
  const m = client.mailbox;
  if (!m || typeof m === "boolean" || m.uidValidity === undefined) return null;
  return String(m.uidValidity);
}

/**
 * Poll one mailbox: read messages newer than the stored cursor (or the last few days on first
 * contact), feed them through the reply matcher, advance the cursor. Read-only for the mailbox:
 * no flags are changed, so a user's own inbox is left exactly as they see it.
 */
export async function pollAccount(ctx: AppContext, account: ImapAccount, factory: ImapClientFactory = defaultFactory): Promise<number> {
  const log = ctx.logger.child({ job: "imap.poll", account: account.key });
  const [cursor] = await ctx.db.select().from(imapCursors).where(eq(imapCursors.accountKey, account.key)).limit(1);
  const client = factory(account);
  let processed = 0;
  let maxUid = cursor?.lastUid ?? 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock(account.mailbox);
    try {
      const validity = uidValidityOf(client);
      const fresh = !cursor || (validity !== null && cursor.uidValidity !== null && cursor.uidValidity !== validity);
      let uids: number[] = [];
      if (fresh) {
        uids = (await client.search({ since: new Date(Date.now() - INITIAL_LOOKBACK_MS) }, { uid: true })) || [];
        maxUid = 0;
      } else {
        uids = ((await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > cursor.lastUid);
      }
      for (const uid of uids.sort((a, b) => a - b)) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const mail = await simpleParser(msg.source);
        const parsed = parsedMailToInbound(mail, mail.messageId ?? `${account.key}:${uid}`);
        const result = await recordInbound(ctx, "imap", parsed);
        processed++;
        maxUid = Math.max(maxUid, uid);
        log.info({ uid, matched: result.matched, method: result.method }, "imap message processed");
      }
      await ctx.db
        .insert(imapCursors)
        .values({ accountKey: account.key, uidValidity: validity, lastUid: maxUid, lastPolledAt: new Date(), lastError: null, updatedAt: new Date() })
        .onConflictDoUpdate({ target: imapCursors.accountKey, set: { uidValidity: validity, lastUid: maxUid, lastPolledAt: new Date(), lastError: null, updatedAt: new Date() } });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return processed;
}

/** Runs every 2 minutes from the worker: poll every configured mailbox, recording per-account errors. */
export async function runImapPoll(ctx: AppContext, factory: ImapClientFactory = defaultFactory): Promise<{ processed: number; accounts: number; errors: number }> {
  const accounts = await listImapAccounts(ctx);
  let processed = 0;
  let errors = 0;
  for (const account of accounts) {
    try {
      processed += await pollAccount(ctx, account, factory);
    } catch (err) {
      errors++;
      const message = ((err as Error).message ?? String(err)).slice(0, 1000);
      ctx.logger.warn({ err, account: account.key }, "imap poll failed");
      await ctx.db
        .insert(imapCursors)
        .values({ accountKey: account.key, lastPolledAt: new Date(), lastError: message, updatedAt: new Date() })
        .onConflictDoUpdate({ target: imapCursors.accountKey, set: { lastPolledAt: new Date(), lastError: message, updatedAt: new Date() } });
    }
  }
  if (accounts.length) ctx.metrics.emit("imap_messages", processed);
  return { processed, accounts: accounts.length, errors };
}

/** Connect, open the mailbox and report how many messages it holds; used by the profile "Test connection" button. */
export async function testImapAccount(account: ImapAccount, factory: ImapClientFactory = defaultFactory): Promise<{ ok: true; recentMessages: number }> {
  const client = factory(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(account.mailbox);
    try {
      const uids = (await client.search({ since: new Date(Date.now() - INITIAL_LOOKBACK_MS) }, { uid: true })) || [];
      return { ok: true, recentMessages: uids.length };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}
