# Testing

## Suites

| Suite | Command | Needs | Covers |
|---|---|---|---|
| API unit | `npx vitest run test/unit` (in `apps/api`) | nothing | Excel parsing/mapping, validator, send-window math, tokens, rate limiter, in-memory queue, rendering, website extraction, SES event normalisation, inbound parsing, config, prompts |
| API integration | `npx vitest run test/integration` | Postgres `mailapp_test` on 5433 | Auth/RBAC/CSRF/lockout/refresh rotation, campaign import + preview, full pipeline (research → draft → review → send) with mock LLM and mock SES, auto mode + validator retry, failures/retry, pause/resume, regenerate/approve-all, SES event webhook (Delivery/Open/Click/Bounce/Complaint/Reject, dedupe, topic allow-list, SNS confirmation), inbound replies (message-id and sender fallback, auto-reply detection), follow-up scheduling/threading/completion, send window, daily cap, suppression at send time, permanent SES errors, send-test, settings, services/instructions/suppressions, unsubscribe pages, analytics, system status |
| Dashboard | `npm run test -w apps/web` | nothing | API client (CSRF, refresh-on-401, error parsing), StatusBadge, header mapping preview, sequence editor, login page |
| Infra | `npm run test -w infra/cdk` | nothing | Synthesises all stacks and asserts SES config set + event destination, SNS subscriptions, ECS services/task env+secrets, least-privilege IAM, alarms, encrypted buckets/RDS |

Create the test database once:

```bash
docker compose up -d postgres
docker exec mailapp-postgres psql -U mailapp -d mailapp -c "CREATE DATABASE mailapp_test"
```

Integration tests run migrations automatically and truncate all tables before each test. They use an
in-memory job queue (`MemoryQueue.drain()` runs the worker handlers inline) so the whole pipeline runs
deterministically in-process.

## Mock behaviours

- `LLM_PROVIDER=mock`: deterministic persona/draft from the lead row. Per-lead switches via the
  `notes` column: `mock:fail-research`, `mock:fail-draft`, `mock:long-draft` (fails the word limit
  once), `mock:banned` (uses a banned phrase once).
- `SES_MODE=mock`: fake message ids; recipients starting with `fail@` raise `MessageRejected`.

## Live AWS checklist (after IAM/SES are provided)

1. `SES_MODE=ses`, credentials in place → **Dashboard → SES account** shows real quotas.
2. Send-test from a pending draft to your own mailbox.
3. Confirm the SNS subscription (watch API logs for `SNS subscription confirmed`).
4. Send a real one-lead campaign; verify Delivery/Open events and the unsubscribe link.
5. Reply and verify the lead flips to replied.
6. `LLM_PROVIDER=anthropic`: run one research + draft and inspect the persona sources and token usage
   under **Dashboard → LLM usage**.
