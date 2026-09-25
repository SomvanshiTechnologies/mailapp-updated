import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import type { AuditFacets, AuditLogDto, Paginated } from "@mailapp/shared";
import type { Db } from "../../db/client.js";
import { auditLogs, type AuditLogRow } from "../../db/schema.js";
import type { Logger } from "../../observability/logger.js";

export interface AuditEntry {
  userId?: string | null;
  userEmail?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export interface AuditListOptions {
  page: number;
  pageSize: number;
  /** Exact action ("campaign.start") or a group prefix without a dot ("campaign"). */
  action?: string;
  /** Case-insensitive substring of the user's email; "system" matches entries without a user. */
  user?: string;
  entityType?: string;
  entityId?: string;
  /** Inclusive lower bound (ISO date or date-time). */
  from?: string;
  /** Exclusive upper bound when a date-time is given; a plain date includes the whole day. */
  to?: string;
  /** Free text over action, user email, entity id, IP and metadata. */
  q?: string;
}

export function toAuditDto(r: AuditLogRow): AuditLogDto {
  return {
    id: r.id,
    userId: r.userId,
    userEmail: r.userEmail,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata: r.metadata ?? null,
    ip: r.ip,
    createdAt: r.createdAt.toISOString(),
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A bare "YYYY-MM-DD" upper bound means "through the end of that day". */
function upperBound(to: string): Date {
  const d = new Date(to);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export function auditFilter(opts: Omit<AuditListOptions, "page" | "pageSize">): SQL | undefined {
  const clauses: SQL[] = [];
  if (opts.action) {
    clauses.push(opts.action.includes(".") ? eq(auditLogs.action, opts.action) : ilike(auditLogs.action, `${escapeLike(opts.action)}.%`));
  }
  if (opts.user) {
    clauses.push(
      opts.user.toLowerCase() === "system"
        ? sql`${auditLogs.userEmail} is null`
        : ilike(auditLogs.userEmail, `%${escapeLike(opts.user)}%`),
    );
  }
  if (opts.entityType) clauses.push(eq(auditLogs.entityType, opts.entityType));
  if (opts.entityId) clauses.push(eq(auditLogs.entityId, opts.entityId));
  if (opts.from) clauses.push(gte(auditLogs.createdAt, new Date(opts.from)));
  if (opts.to) clauses.push(lt(auditLogs.createdAt, upperBound(opts.to)));
  if (opts.q) {
    const term = `%${escapeLike(opts.q)}%`;
    clauses.push(
      or(
        ilike(auditLogs.action, term),
        ilike(auditLogs.userEmail, term),
        ilike(auditLogs.entityId, term),
        ilike(auditLogs.ip, term),
        sql`${auditLogs.metadata}::text ilike ${term}`,
      )!,
    );
  }
  return clauses.length ? and(...clauses) : undefined;
}

export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.db.insert(auditLogs).values({
        userId: entry.userId ?? null,
        userEmail: entry.userEmail ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: entry.metadata,
        ip: entry.ip,
      });
      this.logger.info({ audit: entry }, "audit");
    } catch (err) {
      // Audit must never break the main flow, but it must be visible.
      this.logger.error({ err, entry }, "audit log write failed");
    }
  }

  async list(opts: AuditListOptions): Promise<Paginated<AuditLogDto>> {
    const where = auditFilter(opts);
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(where);
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize);
    return { items: rows.map(toAuditDto), page: opts.page, pageSize: opts.pageSize, total: count };
  }

  /** Distinct values for the filter drop-downs. */
  async facets(): Promise<AuditFacets> {
    const [actions, entityTypes, users] = await Promise.all([
      this.db.selectDistinct({ v: auditLogs.action }).from(auditLogs).orderBy(auditLogs.action),
      this.db.selectDistinct({ v: auditLogs.entityType }).from(auditLogs).orderBy(auditLogs.entityType),
      this.db.selectDistinct({ v: auditLogs.userEmail }).from(auditLogs).orderBy(auditLogs.userEmail),
    ]);
    return {
      actions: actions.map((r) => r.v),
      entityTypes: entityTypes.map((r) => r.v).filter((v): v is string => !!v),
      users: users.map((r) => r.v).filter((v): v is string => !!v),
    };
  }
}
