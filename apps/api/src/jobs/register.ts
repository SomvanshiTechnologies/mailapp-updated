import { JOB_QUEUES } from "@mailapp/shared";
import type { AppContext } from "../context.js";
import type { DraftJob, ResearchJob, SendJob, TickJob } from "./types.js";
import { runResearchJob } from "../modules/pipeline/research.js";
import { runDraftJob } from "../modules/pipeline/draft.js";
import { runSendJob } from "../modules/ses/sender.js";
import { runFollowupTick } from "../modules/followups/scheduler.js";
import { runSesSync } from "../modules/ses/sync.js";
import { runImapPoll } from "../modules/ses/imap.js";
import { runBatchTick } from "../modules/llm/batch/runner.js";

/** Wrap a handler with logging + failure metrics. */
function wrap<T extends object>(ctx: AppContext, name: string, fn: (data: T) => Promise<unknown>) {
  return async (data: T, meta: { id: string }) => {
    const log = ctx.logger.child({ queue: name, jobId: meta.id });
    const started = Date.now();
    try {
      await fn(data);
      log.debug({ ms: Date.now() - started }, "job done");
    } catch (err) {
      ctx.metrics.emit("job_failures", 1, { queue: name });
      log.error({ err, data, ms: Date.now() - started }, "job failed");
      throw err;
    }
  };
}

export async function registerJobHandlers(ctx: AppContext): Promise<void> {
  const c = ctx.config;
  await ctx.queue.work<ResearchJob>(JOB_QUEUES.research, { concurrency: c.WORKER_RESEARCH_CONCURRENCY }, wrap(ctx, JOB_QUEUES.research, (d) => runResearchJob(ctx, d)));
  await ctx.queue.work<DraftJob>(JOB_QUEUES.draft, { concurrency: c.WORKER_DRAFT_CONCURRENCY }, wrap(ctx, JOB_QUEUES.draft, (d) => runDraftJob(ctx, d)));
  await ctx.queue.work<SendJob>(JOB_QUEUES.send, { concurrency: c.WORKER_SEND_CONCURRENCY }, wrap(ctx, JOB_QUEUES.send, (d) => runSendJob(ctx, d)));
  await ctx.queue.work<TickJob>(JOB_QUEUES.followupTick, { concurrency: 1, pollingIntervalSeconds: 5 }, wrap(ctx, JOB_QUEUES.followupTick, () => runFollowupTick(ctx)));
  await ctx.queue.work<TickJob>(JOB_QUEUES.sesSync, { concurrency: 1, pollingIntervalSeconds: 10 }, wrap(ctx, JOB_QUEUES.sesSync, () => runSesSync(ctx)));
  await ctx.queue.work<TickJob>(JOB_QUEUES.metricsFlush, { concurrency: 1, pollingIntervalSeconds: 10 }, wrap(ctx, JOB_QUEUES.metricsFlush, () => ctx.metrics.flush()));
  await ctx.queue.work<TickJob>(JOB_QUEUES.imapPoll, { concurrency: 1, pollingIntervalSeconds: 10 }, wrap(ctx, JOB_QUEUES.imapPoll, () => runImapPoll(ctx)));
  // Single worker: the tick flushes and polls batches, and two of them would race on the
  // same pending groups.
  await ctx.queue.work<TickJob>(JOB_QUEUES.llmBatchTick, { concurrency: 1, pollingIntervalSeconds: 5 }, wrap(ctx, JOB_QUEUES.llmBatchTick, () => runBatchTick(ctx)));
}

export async function registerSchedules(ctx: AppContext): Promise<void> {
  await ctx.queue.schedule(JOB_QUEUES.followupTick, "* * * * *");
  await ctx.queue.schedule(JOB_QUEUES.sesSync, "*/5 * * * *");
  await ctx.queue.schedule(JOB_QUEUES.metricsFlush, "* * * * *");
  // Always scheduled: the poll enumerates the organisation mailbox (env) and users' own mailboxes.
  await ctx.queue.schedule(JOB_QUEUES.imapPoll, "*/2 * * * *");
  await ctx.queue.schedule(JOB_QUEUES.llmBatchTick, "* * * * *");
  // Kick an initial sync so the dashboard has data right after boot.
  await ctx.queue.publish(JOB_QUEUES.sesSync, {}, { singletonKey: "ses.sync:boot", retryLimit: 0 });
}
