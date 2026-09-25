import { and, eq, gt, isNull } from "drizzle-orm";
import type { DashboardScope, UserDto, UserRole } from "@mailapp/shared";
import type { Db } from "../../db/client.js";
import { refreshTokens, users, type UserRow } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { encryptSecret, randomToken, sha256 } from "../../lib/crypto.js";
import { hashPassword, verifyPassword } from "./password.js";
import { JwtService, type AccessClaims } from "./jwt.js";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/** Values that need a lookup beyond the user row (filled in by the routes). */
export interface UserDtoExtras {
  imapLastPolledAt?: string | null;
  imapLastError?: string | null;
  effectiveReplyTo?: string;
}

export function toUserDto(u: UserRow, extras: UserDtoExtras = {}): UserDto {
  return {
    imap: {
      enabled: u.imapEnabled,
      host: u.imapHost,
      port: u.imapPort,
      user: u.imapUser,
      mailbox: u.imapMailbox,
      passwordSet: !!u.imapPasswordEnc,
      lastPolledAt: extras.imapLastPolledAt ?? null,
      lastError: extras.imapLastError ?? null,
    },
    effectiveReplyTo: extras.effectiveReplyTo ?? "",
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    fromEmail: u.fromEmail,
    fromName: u.fromName,
    replyTo: u.replyTo,
    postalAddress: u.postalAddress,
    dashboardScope: u.dashboardScope,
  };
}

/** Sender identity fields shared by create/update. "" clears a field (falls back to org settings). */
export interface SenderProfileFields {
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
  postalAddress?: string;
  imapEnabled?: boolean;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  /** undefined = keep, "" = clear, otherwise stored encrypted. */
  imapPassword?: string;
  imapMailbox?: string;
}

function senderColumns(input: SenderProfileFields, appSecret: string): Partial<typeof users.$inferInsert> {
  const set: Partial<typeof users.$inferInsert> = {};
  const norm = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);
  if (input.fromEmail !== undefined) set.fromEmail = norm(input.fromEmail)?.toLowerCase() ?? null;
  if (input.fromName !== undefined) set.fromName = norm(input.fromName);
  if (input.replyTo !== undefined) set.replyTo = norm(input.replyTo)?.toLowerCase() ?? null;
  if (input.postalAddress !== undefined) set.postalAddress = norm(input.postalAddress);
  if (input.imapEnabled !== undefined) set.imapEnabled = input.imapEnabled;
  if (input.imapHost !== undefined) set.imapHost = norm(input.imapHost);
  if (input.imapPort !== undefined) set.imapPort = input.imapPort;
  if (input.imapUser !== undefined) set.imapUser = norm(input.imapUser);
  if (input.imapMailbox !== undefined) set.imapMailbox = norm(input.imapMailbox) ?? "INBOX";
  if (input.imapPassword !== undefined) set.imapPasswordEnc = input.imapPassword ? encryptSecret(appSecret, input.imapPassword) : null;
  return set;
}

export interface LoginResult {
  user: UserDto;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    public readonly jwt: JwtService,
    private readonly refreshTtlDays: number,
    /** Encrypts stored mailbox passwords. */
    private readonly appSecret: string = "",
  ) {}

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<LoginResult> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    // Always run a hash verification to keep timing similar for unknown users.
    const ok = user ? await verifyPassword(user.passwordHash, password) : await verifyPassword(DUMMY_HASH, password);
    if (!user || !user.isActive) throw AppError.unauthorized("Invalid email or password", "invalid_credentials");
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw AppError.unauthorized("Account temporarily locked. Try again later.", "account_locked");
    }
    if (!ok) {
      const attempts = user.failedLoginAttempts + 1;
      await this.db
        .update(users)
        .set({
          failedLoginAttempts: attempts,
          lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        })
        .where(eq(users.id, user.id));
      throw AppError.unauthorized("Invalid email or password", "invalid_credentials");
    }
    await this.db
      .update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.id, user.id));
    return this.issue(user, meta);
  }

  private async issue(user: UserRow, meta: { ip?: string; userAgent?: string }): Promise<LoginResult> {
    const accessToken = await this.jwt.sign(claimsFor(user));
    const refreshToken = randomToken(48);
    const refreshExpiresAt = new Date(Date.now() + this.refreshTtlDays * 86_400_000);
    await this.db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: refreshExpiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 500),
    });
    return { user: toUserDto(user), accessToken, refreshToken, refreshExpiresAt };
  }

  /** Rotate a refresh token: revoke the old one, issue a new pair. */
  async refresh(token: string, meta: { ip?: string; userAgent?: string }): Promise<LoginResult> {
    const tokenHash = sha256(token);
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())))
      .limit(1);
    if (!row) throw AppError.unauthorized("Refresh token invalid", "invalid_refresh");
    const [user] = await this.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!user || !user.isActive) throw AppError.unauthorized("User disabled", "invalid_refresh");
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
    return this.issue(user, meta);
  }

  async revoke(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, sha256(token)));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, userId));
  }

  async getUser(id: string): Promise<UserRow | null> {
    const [u] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return u ?? null;
  }

  async createUser(input: { email: string; name: string; password: string; role: UserRole; dashboardScope?: DashboardScope } & SenderProfileFields): Promise<UserRow> {
    const passwordHash = await hashPassword(input.password);
    try {
      const [u] = await this.db
        .insert(users)
        .values({
          email: input.email.toLowerCase(),
          name: input.name,
          passwordHash,
          role: input.role,
          dashboardScope: input.dashboardScope ?? "own",
          ...senderColumns(input, this.appSecret),
        })
        .returning();
      return u;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw AppError.conflict("A user with that email already exists");
      throw err;
    }
  }

  async updateUser(
    id: string,
    input: { name?: string; role?: UserRole; isActive?: boolean; password?: string; dashboardScope?: DashboardScope } & SenderProfileFields,
  ): Promise<UserRow> {
    const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date(), ...senderColumns(input, this.appSecret) };
    if (input.name !== undefined) set.name = input.name;
    if (input.role !== undefined) set.role = input.role;
    if (input.isActive !== undefined) set.isActive = input.isActive;
    if (input.dashboardScope !== undefined) set.dashboardScope = input.dashboardScope;
    if (input.password !== undefined) set.passwordHash = await hashPassword(input.password);
    const [u] = await this.db.update(users).set(set).where(eq(users.id, id)).returning();
    if (!u) throw AppError.notFound("User");
    if (input.password !== undefined || input.isActive === false) await this.revokeAllForUser(id);
    return u;
  }

  /** Hard delete. FKs keep campaigns/emails/audit rows (owner set to null) and cascade personal docs, grants and tokens. */
  async deleteUser(id: string): Promise<void> {
    const deleted = await this.db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
    if (!deleted.length) throw AppError.notFound("User");
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.getUser(userId);
    if (!user) throw AppError.notFound("User");
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw AppError.unauthorized("Current password is incorrect", "invalid_credentials");
    }
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(users.id, userId));
    await this.revokeAllForUser(userId);
  }

  async listUsers(): Promise<UserRow[]> {
    return this.db.select().from(users).orderBy(users.createdAt);
  }

  async countUsers(): Promise<number> {
    const rows = await this.db.select({ id: users.id }).from(users);
    return rows.length;
  }
}

function claimsFor(u: UserRow): AccessClaims {
  return { sub: u.id, email: u.email, role: u.role, name: u.name };
}

// argon2id hash of a random string; used to equalise timing for unknown emails.
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Q2hlY2tpbmdEdW1teUhhc2hWYWx1ZUZvclRpbWluZw";
