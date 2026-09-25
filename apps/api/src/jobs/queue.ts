import PgBoss from "pg-boss";
import pg from "pg";
import type { QueueStat } from "@mailapp/shared";
import { JOB_QUEUES } from "@mailapp/shared";
import type { Logger } from "../observability/logger.js";

export interface PublishOptions {
  /** Delay in seconds or an absolute Date. */
  startAfter?: number | Date;
  /** Only one queued/active job with this key at a time. */
  singletonKey?: string;
  retryLimit?: number;
  retryDelaySeconds?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
  priority?: number;
}

export type JobHandler<T> = (data: T, meta: { id: string; name: string }) => Promise<void>;

export interface JobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  publish<T extends object>(name: string, data: T, opts?: PublishOptions): Promise<string | null>;
  work<T extends object>(name: string, opts: { concurrency: number; pollingIntervalSeconds?: number }, handler: JobHandler<T>): Promise<void>;
  schedule(name: string, cron: string, data?: object): Promise<void>;
  cancel(name: string, jobId: string): Promise<void>;
  stats(): Promise<QueueStat[]>;
  healthy(): Promise<boolean>;
}

const ALL_QUEUES = Object.values(JOB_QUEUES);

/** pg-boss backed queue. Jobs live in the `pgboss` schema of the app database. */
export class PgBossQueue implements JobQueue {
  private boss: PgBoss;
  private started = false;

  constructor(
    private readonly connectionString: string,
    private readonly logger: Logger,
  ) {
    this.boss = new PgBoss({
      connectionString,
      schema: "pgboss",
      max: 5,
      archiveCompletedAfterSeconds: 7 * 86_400,
      deleteAfterDays: 30,
      maintenanceIntervalSeconds: 300,
    });
    this.boss.on("error", (err) => this.logger.error({ err }, "pg-boss error"));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    for (const q of ALL_QUEUES) {
      await this.boss.createQueue(q).catch((err: unknown) => {
        // createQueue is idempotent in v10 but be defensive across versions.
        this.logger.debug({ err, q }, "createQueue");
      });
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: true, timeout: 15_000 });
    this.started = false;
  }

  async publish<T extends object>(name: string, data: T, opts: PublishOptions = {}): Promise<string | null> {
    // pg-boss asserts on the *presence* of some keys (e.g. priority must be an integer), so only
    // include options that are actually set.
    const sendOpts: PgBoss.SendOptions = {
      retryLimit: opts.retryLimit ?? 3,
      retryDelay: opts.retryDelaySeconds ?? 30,
      retryBackoff: opts.retryBackoff ?? true,
      expireInSeconds: opts.expireInSeconds ?? 15 * 60,
    };
    if (opts.priority !== undefined) sendOpts.priority = opts.priority;
    if (opts.singletonKey !== undefined) sendOpts.singletonKey = opts.singletonKey;
    if (opts.startAfter !== undefined) sendOpts.startAfter = opts.startAfter;
    return this.boss.send(name, data, sendOpts);
  }

  async work<T extends object>(
    name: string,
    opts: { concurrency: number; pollingIntervalSeconds?: number },
    handler: JobHandler<T>,
  ): Promise<void> {
    // pg-boss v10 has no per-worker concurrency option: register one poller per slot.
    for (let i = 0; i < Math.max(1, opts.concurrency); i++) {
      await this.boss.work<T>(
        name,
        { batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 },
        async (jobs) => {
          for (const job of jobs) {
            await handler(job.data, { id: job.id, name: job.name });
          }
        },
      );
    }
  }

  async schedule(name: string, cron: string, data: object = {}): Promise<void> {
    await this.boss.schedule(name, cron, data, { tz: "UTC" });
  }

  async cancel(name: string, jobId: string): Promise<void> {
    await this.boss.cancel(name, jobId);
  }

  async stats(): Promise<QueueStat[]> {
    const pool = new pg.Pool({ connectionString: this.connectionString, max: 1 });
    try {
      const res = await pool.query<{ name: string; state: string; count: string }>(
        `select name, state, count(*)::text as count from pgboss.job group by name, state`,
      );
      const byQueue = new Map<string, QueueStat>();
      for (const q of ALL_QUEUES) byQueue.set(q, { queue: q, created: 0, active: 0, completed: 0, failed: 0, retry: 0 });
      for (const r of res.rows) {
        const s = byQueue.get(r.name) ?? { queue: r.name, created: 0, active: 0, completed: 0, failed: 0, retry: 0 };
        const n = Number(r.count);
        if (r.state === "created") s.created += n;
        else if (r.state === "active") s.active += n;
        else if (r.state === "completed") s.completed += n;
        else if (r.state === "failed" || r.state === "cancelled" || r.state === "expired") s.failed += n;
        else if (r.state === "retry") s.retry += n;
        byQueue.set(r.name, s);
      }
      return [...byQueue.values()];
    } catch (err) {
      this.logger.warn({ err }, "queue stats failed");
      return ALL_QUEUES.map((q) => ({ queue: q, created: 0, active: 0, completed: 0, failed: 0, retry: 0 }));
    } finally {
      await pool.end();
    }
  }

  async healthy(): Promise<boolean> {
    return this.started;
  }
}

/**
 * In-memory queue for tests and single-process dev. Jobs run immediately when `drain()` is
 * called (or automatically when `autoRun` is true), preserving publish order.
 */
export class MemoryQueue implements JobQueue {
  private handlers = new Map<string, JobHandler<object>>();
  private pending: Array<{ id: string; name: string; data: object; runAt: number; singletonKey?: string }> = [];
  private counter = 0;
  public readonly published: Array<{ name: string; data: object; opts?: PublishOptions }> = [];
  public readonly schedules: Array<{ name: string; cron: string }> = [];
  public failures: Array<{ name: string; data: object; error: unknown }> = [];

  constructor(private readonly autoRun = false) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async publish<T extends object>(name: string, data: T, opts: PublishOptions = {}): Promise<string | null> {
    if (opts.singletonKey && this.pending.some((p) => p.name === name && p.singletonKey === opts.singletonKey)) return null;
    const id = `mem-${++this.counter}`;
    const runAt =
      opts.startAfter instanceof Date
        ? opts.startAfter.getTime()
        : typeof opts.startAfter === "number"
          ? Date.now() + opts.startAfter * 1000
          : 0;
    this.pending.push({ id, name, data, runAt, singletonKey: opts.singletonKey });
    this.published.push({ name, data, opts });
    if (this.autoRun) queueMicrotask(() => void this.drain());
    return id;
  }

  async work<T extends object>(name: string, _opts: { concurrency: number }, handler: JobHandler<T>): Promise<void> {
    this.handlers.set(name, handler as JobHandler<object>);
  }

  async schedule(name: string, cron: string): Promise<void> {
    this.schedules.push({ name, cron });
  }

  async cancel(_name: string, jobId: string): Promise<void> {
    this.pending = this.pending.filter((p) => p.id !== jobId);
  }

  /** Run every due job (and jobs they enqueue) until the queue is empty. */
  async drain(opts: { includeFuture?: boolean; maxIterations?: number } = {}): Promise<number> {
    let ran = 0;
    const max = opts.maxIterations ?? 10_000;
    while (ran < max) {
      const idx = this.pending.findIndex((p) => opts.includeFuture || p.runAt <= Date.now());
      if (idx === -1) break;
      const [job] = this.pending.splice(idx, 1);
      const handler = this.handlers.get(job.name);
      if (!handler) continue;
      try {
        await handler(job.data, { id: job.id, name: job.name });
      } catch (error) {
        this.failures.push({ name: job.name, data: job.data, error });
      }
      ran++;
    }
    return ran;
  }

  pendingJobs(): Array<{ name: string; data: object; runAt: number }> {
    return this.pending.map((p) => ({ name: p.name, data: p.data, runAt: p.runAt }));
  }

  async stats(): Promise<QueueStat[]> {
    const map = new Map<string, QueueStat>();
    for (const q of ALL_QUEUES) map.set(q, { queue: q, created: 0, active: 0, completed: 0, failed: 0, retry: 0 });
    for (const p of this.pending) {
      const s = map.get(p.name)!;
      if (s) s.created++;
    }
    for (const f of this.failures) {
      const s = map.get(f.name);
      if (s) s.failed++;
    }
    return [...map.values()];
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}
