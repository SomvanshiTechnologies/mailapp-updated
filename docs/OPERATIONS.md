# Operations runbook

## Processes

| Process | Entry point | Responsibilities |
|---|---|---|
| API | `node apps/api/dist/server.js` | HTTP API, dashboard, webhooks, unsubscribe pages; publishes jobs |
| Worker | `node apps/api/dist/worker.js` | Research, drafting, sending, follow-up tick (1 min), SES sync (5 min), metrics flush, IMAP poll |
| Migrate | `node apps/api/dist/db/migrate.js` | Applies SQL migrations from `apps/api/drizzle` |

Jobs are stored in Postgres (`pgboss` schema). Retries: 3 with exponential backoff; failed jobs are visible
under **System → queues** and in `pgboss.job`.

## Logs

CloudWatch log groups: `/mailapp/<env>/api`, `/mailapp/<env>/worker`, `/mailapp/<env>/migrate`.
Every line is JSON. Useful Logs Insights queries:

```
# Requests by status for one request id
fields @timestamp, reqId, msg, res.statusCode | filter reqId = "…" | sort @timestamp asc

# Send failures in the last hour
fields @timestamp, emailId, err.name, err.message | filter msg = "send failed" | sort @timestamp desc

# LLM errors
fields @timestamp, leadId, err.message | filter msg like /research failed|draft failed/ | sort @timestamp desc

# Webhook signature problems
fields @timestamp, topic, err.message | filter msg = "SNS signature validation failed"
```

## Metrics and alarms

Namespace `MailApp` (dimension `Service` = api|worker, plus per-metric dimensions):

| Metric | Meaning / action |
|---|---|
| `emails_sent`, `send_failures{permanent}` | Permanent failures show on the email and lead; check `send_attempts` |
| `send_rate_limited{reason}` | `daily_cap` hits mean the cap or SES quota is exhausted |
| `llm_calls`, `llm_failures`, `llm_latency_ms`, `llm_*_tokens` | Cost and health of the model layer |
| `drafts_rejected_by_validator` | Rising values mean the instructions and hard rules conflict |
| `bounces`, `complaints`, `unsubscribes`, `replies` | Reputation and outcome signals |
| `queue_depth{queue}`, `job_failures{queue}` | Worker backlog and errors |

SES metrics (namespace `AWS/SES`, dimension `ses:configuration-set`): Send, Delivery, Bounce,
Complaint, Reject, Open, Click, RenderingFailure, DeliveryDelay, `Reputation.BounceRate`,
`Reputation.ComplaintRate`.

Alarms (Observability stack): bounce rate > 5%, complaint rate > 0.1%, ALB 5xx, worker running count
< 1, RDS free storage. All notify the alerts SNS topic.

## Common tasks

**Pause all sending** — pause each active campaign (Campaigns → Pause), or set `dailyCap` to `0`
is *not* a pause (0 = unlimited); set it to `1` for an effective stop, or scale the worker service to 0.

**Bounce/complaint spike** — pause campaigns, inspect the latest Bounce events (Dashboard → events),
check the SES account *enforcement status*; the app has already suppressed the addresses. Review the
lead source quality before resuming. If SES paused the account, follow the review process in the console.

**Reply not detected** — check `inbound_messages` for the message (matched lead id and method). Replies
match by `In-Reply-To`/`References` against stored message ids, then by sender address within 90 days.
Mark the lead replied manually from the lead page if needed.

**Regenerate drafts after changing instructions** — instructions apply to new drafts only. Use
*Regenerate* on pending drafts, or *re-research* to refresh personas.

**Rotate secrets** — update the Secrets Manager values, then force a new ECS deployment
(`aws ecs update-service --force-new-deployment`). Rotating `JWT_SECRET` logs every user out.

**Scale workers** — increase `workerDesiredCount` and/or `WORKER_*_CONCURRENCY`. Keep
`LLM_MAX_CONCURRENCY × workers` within your Anthropic rate limit and `WORKER_SEND_CONCURRENCY × workers`
below the SES max send rate (the per-process token bucket also enforces `maxSendRate`).

**Backups** — RDS automated backups (7 days). Restore to a new instance, update the `DATABASE_URL`
secret, redeploy. Uploaded sheets and exports live in the storage bucket (versioned).

**Upgrade** — `npm run build`, run the migration task, then deploy the new image
(`cdk deploy MailApp-<env>-Compute`). Migrations are additive; never edit an applied migration.

## Data retention

`email_events`, `send_attempts` and `llm_calls` grow with volume. Archive or truncate rows older than
your retention policy; nothing in the app depends on events older than the lead lifecycle.
