import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ChangePasswordSchema, CreateUserSchema, LoginSchema, UpdateProfileSchema, UpdateUserSchema, type UserStatsDto } from "@mailapp/shared";
import type { AppContext } from "../../context.js";
import { campaigns, emails, imapCursors, users, type UserRow } from "../../db/schema.js";
import { parse, requireUuid } from "../../lib/validate.js";
import { AppError } from "../../lib/errors.js";
import { decryptSecret } from "../../lib/crypto.js";
import { utcDay } from "../../lib/time.js";
import { assertSenderVerified, resolveSender } from "../settings/sender.js";
import { testImapAccount, type ImapClientFactory } from "../ses/imap.js";
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieOptions } from "./plugin.js";
import { toUserDto, type LoginResult, type UserDtoExtras } from "./service.js";

/** IMAP settings only make sense complete; refuse to enable polling with pieces missing. */
function assertImapComplete(existing: UserRow | null, body: { imapEnabled?: boolean; imapHost?: string; imapUser?: string; imapPassword?: string }): void {
  const enabled = body.imapEnabled ?? existing?.imapEnabled ?? false;
  if (!enabled) return;
  const host = body.imapHost !== undefined ? body.imapHost.trim() : existing?.imapHost;
  const user = body.imapUser !== undefined ? body.imapUser.trim() : existing?.imapUser;
  const password = body.imapPassword !== undefined ? body.imapPassword : existing?.imapPasswordEnc ? "set" : "";
  if (!host || !user || !password) throw AppError.badRequest("To enable reply polling, fill in the IMAP host, username and password");
}

export interface AuthRoutesOptions {
  /** Test hook: substitute the IMAP client used by the connection test. */
  imapClientFactory?: ImapClientFactory;
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext, opts: AuthRoutesOptions = {}): Promise<void> {
  /** Cursor status of the user's mailbox and the Reply-To their campaigns will carry. */
  const extrasFor = async (u: UserRow): Promise<UserDtoExtras> => {
    const [cursor] = await ctx.db.select().from(imapCursors).where(eq(imapCursors.accountKey, `user:${u.id}`)).limit(1);
    const sender = await resolveSender(ctx, { createdBy: u.id, fromEmail: null, fromName: null, replyTo: null });
    return { imapLastPolledAt: cursor?.lastPolledAt?.toISOString() ?? null, imapLastError: cursor?.lastError ?? null, effectiveReplyTo: sender.replyTo };
  };
  const setCookies = (reply: import("fastify").FastifyReply, r: LoginResult) => {
    reply.setCookie(ACCESS_COOKIE, r.accessToken, cookieOptions(ctx, "/", ctx.config.ACCESS_TOKEN_TTL_MINUTES * 60));
    reply.setCookie(REFRESH_COOKIE, r.refreshToken, cookieOptions(ctx, "/api/auth", ctx.config.REFRESH_TOKEN_TTL_DAYS * 86_400));
  };
  const clearCookies = (reply: import("fastify").FastifyReply) => {
    reply.clearCookie(ACCESS_COOKIE, { path: "/" });
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
  };

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: ctx.config.isTest ? 100_000 : 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = parse(LoginSchema, req.body);
      const result = await ctx.auth.login(body.email, body.password, { ip: req.ip, userAgent: req.headers["user-agent"] });
      setCookies(reply, result);
      await ctx.audit.log({ userId: result.user.id, userEmail: result.user.email, action: "auth.login", ip: req.ip });
      return { user: result.user };
    },
  );

  app.post("/api/auth/refresh", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw AppError.unauthorized("No refresh token", "invalid_refresh");
    try {
      const result = await ctx.auth.refresh(token, { ip: req.ip, userAgent: req.headers["user-agent"] });
      setCookies(reply, result);
      return { user: result.user };
    } catch (err) {
      clearCookies(reply);
      throw err;
    }
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await ctx.auth.revoke(req.cookies[REFRESH_COOKIE]);
    clearCookies(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: app.authenticate }, async (req) => {
    const user = await ctx.auth.getUser(req.user!.sub);
    if (!user || !user.isActive) throw AppError.unauthorized("User disabled", "invalid_token");
    return { user: toUserDto(user, await extrasFor(user)) };
  });

  /** Own name, sender identity (from address, name, reply-to, postal address) and reply mailbox. */
  app.patch("/api/auth/me", { preHandler: app.authenticate }, async (req) => {
    const body = parse(UpdateProfileSchema, req.body);
    if (body.fromEmail) await assertSenderVerified(ctx, body.fromEmail);
    assertImapComplete(await ctx.auth.getUser(req.user!.sub), body);
    const user = await ctx.auth.updateUser(req.user!.sub, body);
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "user.update_profile", entityType: "user", entityId: user.id, metadata: { fields: Object.keys(body).filter((k) => k !== "imapPassword"), imapPasswordChanged: body.imapPassword !== undefined }, ip: req.ip });
    return { user: toUserDto(user, await extrasFor(user)) };
  });

  /**
   * Try the caller's mailbox credentials. Body fields override what is stored (so the form can
   * test before saving); the stored password is used when none is supplied.
   */
  app.post("/api/auth/me/imap-test", { preHandler: app.authenticate }, async (req) => {
    const body = parse(UpdateProfileSchema.pick({ imapHost: true, imapPort: true, imapUser: true, imapPassword: true, imapMailbox: true }), req.body ?? {});
    const user = await ctx.auth.getUser(req.user!.sub);
    if (!user) throw AppError.notFound("User");
    const host = (body.imapHost ?? user.imapHost ?? "").trim();
    const login = (body.imapUser ?? user.imapUser ?? "").trim();
    const password = body.imapPassword ?? (user.imapPasswordEnc ? decryptSecret(ctx.config.APP_SECRET, user.imapPasswordEnc) : "");
    if (!host || !login || !password) throw AppError.badRequest("IMAP host, username and password are required");
    try {
      const result = await testImapAccount(
        { key: `user:${user.id}`, label: login, host, port: body.imapPort ?? user.imapPort, user: login, password, mailbox: body.imapMailbox?.trim() || user.imapMailbox || "INBOX" },
        opts.imapClientFactory,
      );
      return result;
    } catch (err) {
      throw AppError.badRequest(`IMAP connection failed: ${(err as Error).message ?? String(err)}`);
    }
  });

  app.post("/api/auth/change-password", { preHandler: app.authenticate }, async (req, reply) => {
    const body = parse(ChangePasswordSchema, req.body);
    await ctx.auth.changePassword(req.user!.sub, body.currentPassword, body.newPassword);
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "auth.change_password", ip: req.ip });
    clearCookies(reply);
    return { ok: true };
  });

  // ----- Users (admin) -----
  app.get("/api/users", { preHandler: app.requireRole("admin") }, async () => {
    const rows = await ctx.auth.listUsers();
    return { items: await Promise.all(rows.map(async (u) => toUserDto(u, await extrasFor(u)))) };
  });

  /** Lightweight directory for pickers (campaign access grants): id, name, email, role. */
  app.get("/api/users/directory", { preHandler: app.authenticate }, async () => {
    const rows = await ctx.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(users.name);
    return { items: rows };
  });

  /** Per-user sending activity: campaigns owned, emails sent (total / 7d / today), queued. */
  app.get("/api/users/stats", { preHandler: app.requireRole("admin") }, async () => {
    const now = new Date();
    const dayStart = new Date(`${utcDay(now)}T00:00:00Z`);
    const weekStart = new Date(now.getTime() - 7 * 86_400_000);
    const campaignRows = await ctx.db
      .select({
        userId: campaigns.createdBy,
        campaigns: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${campaigns.status} = 'active')::int`,
      })
      .from(campaigns)
      .where(isNotNull(campaigns.createdBy))
      .groupBy(campaigns.createdBy);
    // Sent emails are attributed to the sender recorded at send time; older rows (before the
    // column existed) fall back to the campaign owner.
    const attributed = sql`coalesce(${emails.senderUserId}, ${campaigns.createdBy})`;
    const sentRows = await ctx.db
      .select({
        userId: sql<string | null>`${attributed}`,
        total: sql<number>`count(*) filter (where ${emails.sentAt} is not null)::int`,
        week: sql<number>`count(*) filter (where ${emails.sentAt} >= ${weekStart})::int`,
        today: sql<number>`count(*) filter (where ${emails.sentAt} >= ${dayStart})::int`,
        pending: sql<number>`count(*) filter (where ${emails.status} in ('approved','queued','sending'))::int`,
        lastSentAt: sql<string | null>`max(${emails.sentAt})`,
      })
      .from(emails)
      .innerJoin(campaigns, eq(emails.campaignId, campaigns.id))
      .where(eq(emails.direction, "outbound"))
      .groupBy(attributed);
    const byUser = new Map<string, UserStatsDto>();
    const get = (id: string) => {
      let s = byUser.get(id);
      if (!s) {
        s = { userId: id, campaigns: 0, activeCampaigns: 0, sentTotal: 0, sentLast7Days: 0, sentToday: 0, pendingSend: 0, lastSentAt: null };
        byUser.set(id, s);
      }
      return s;
    };
    for (const r of campaignRows) {
      if (!r.userId) continue;
      const s = get(r.userId);
      s.campaigns = r.campaigns;
      s.activeCampaigns = r.active;
    }
    for (const r of sentRows) {
      if (!r.userId) continue;
      const s = get(r.userId);
      s.sentTotal = r.total;
      s.sentLast7Days = r.week;
      s.sentToday = r.today;
      s.pendingSend = r.pending;
      s.lastSentAt = r.lastSentAt ? new Date(r.lastSentAt).toISOString() : null;
    }
    return { items: [...byUser.values()] };
  });

  app.post("/api/users", { preHandler: app.requireRole("admin") }, async (req) => {
    const body = parse(CreateUserSchema, req.body);
    if (body.fromEmail) await assertSenderVerified(ctx, body.fromEmail);
    const user = await ctx.auth.createUser(body);
    await ctx.audit.log({
      userId: req.user!.sub,
      userEmail: req.user!.email,
      action: "user.create",
      entityType: "user",
      entityId: user.id,
      metadata: { email: user.email, role: user.role },
      ip: req.ip,
    });
    return { user: toUserDto(user, await extrasFor(user)) };
  });

  app.patch("/api/users/:id", { preHandler: app.requireRole("admin") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const body = parse(UpdateUserSchema, req.body);
    if (id === req.user!.sub && (body.role !== undefined || body.isActive === false)) {
      throw AppError.badRequest("You cannot change your own role or deactivate yourself");
    }
    if (body.fromEmail) await assertSenderVerified(ctx, body.fromEmail);
    assertImapComplete(await ctx.auth.getUser(id), body);
    const user = await ctx.auth.updateUser(id, body);
    await ctx.audit.log({
      userId: req.user!.sub,
      userEmail: req.user!.email,
      action: "user.update",
      entityType: "user",
      entityId: id,
      metadata: { fields: Object.keys(body).filter((k) => k !== "password" && k !== "imapPassword"), passwordReset: body.password !== undefined },
      ip: req.ip,
    });
    return { user: toUserDto(user, await extrasFor(user)) };
  });

  /**
   * Delete a user. Their campaigns, emails and audit rows are kept (ownership becomes empty
   * and an admin can re-assign via access grants); personal instruction docs and access grants
   * are removed. Active campaigns are paused first so nothing keeps sending in their name.
   */
  app.delete("/api/users/:id", { preHandler: app.requireRole("admin") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    if (id === req.user!.sub) throw AppError.badRequest("You cannot delete yourself");
    const target = await ctx.auth.getUser(id);
    if (!target) throw AppError.notFound("User");
    if (target.role === "admin") {
      const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, "admin"), eq(users.isActive, true)));
      if (n <= 1) throw AppError.conflict("Cannot delete the last active administrator");
    }
    const paused = await pauseUserCampaigns(ctx, id);
    await ctx.auth.deleteUser(id);
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "user.delete", entityType: "user", entityId: id, metadata: { email: target.email, role: target.role, pausedCampaigns: paused }, ip: req.ip });
    return { ok: true, pausedCampaigns: paused };
  });

  /** Admin kill switch: pause every active campaign this user owns; queued sends stay approved but stop going out. */
  app.post("/api/users/:id/stop-sending", { preHandler: app.requireRole("admin") }, async (req) => {
    const id = requireUuid((req.params as { id: string }).id);
    const target = await ctx.auth.getUser(id);
    if (!target) throw AppError.notFound("User");
    const paused = await pauseUserCampaigns(ctx, id);
    await ctx.audit.log({ userId: req.user!.sub, userEmail: req.user!.email, action: "user.stop_sending", entityType: "user", entityId: id, metadata: { email: target.email, pausedCampaigns: paused }, ip: req.ip });
    return { ok: true, pausedCampaigns: paused };
  });
}

async function pauseUserCampaigns(ctx: AppContext, userId: string): Promise<number> {
  const active = await ctx.db.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.createdBy, userId), eq(campaigns.status, "active")));
  if (!active.length) return 0;
  await ctx.db
    .update(campaigns)
    .set({ status: "paused", updatedAt: new Date() })
    .where(inArray(campaigns.id, active.map((c) => c.id)));
  return active.length;
}
