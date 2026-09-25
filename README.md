# Outreach Engine

Internal platform for research-driven cold outreach over Amazon SES:

1. Upload an Excel sheet of leads (known headers, extra columns preserved).
2. Every lead is researched (website + Claude web search) into a structured persona.
3. The best-fit services from your catalogue are matched and a personalised email is drafted
   under your tone/format/rules documents, then checked by a deterministic validator.
4. Drafts go to a review queue (or are auto-approved), are sent through SES with tracking, and
   follow-ups are scheduled and threaded until the lead replies, bounces, complains or unsubscribes.
5. Every SES event (delivery, bounce, complaint, open, click, …) flows back through SNS into the
   dashboard; a status Excel can be exported at any time.

See [PLAN.md](PLAN.md) for the architecture, [docs/API.md](docs/API.md) for the HTTP contract,
[docs/AWS_SETUP.md](docs/AWS_SETUP.md) for deployment, [docs/OPERATIONS.md](docs/OPERATIONS.md) for
the runbook and [docs/TESTING.md](docs/TESTING.md) for the test suites.
New to the project? Start with [docs/HANDOVER.md](docs/HANDOVER.md), the handover and knowledge
transfer document (also exportable to PDF, see its Appendix B).

## Repository

| Path | What |
|---|---|
| `packages/shared` | Zod schemas, enums and DTO types shared by API and dashboard |
| `apps/api` | Fastify API + pg-boss worker (same code, two entrypoints), Drizzle schema, SES/LLM integrations |
| `apps/web` | React dashboard (Vite, Tailwind, TanStack Query, Recharts) |
| `infra/cdk` | AWS CDK app: VPC, RDS, ECS Fargate, ALB, S3, SES config set, SNS, CloudWatch |
| `infra/iam` | IAM policy for running locally against real AWS |
| `Dockerfile`, `docker-compose.yml` | Production image and local stack |

## Quick start (local, no AWS needed)

```bash
npm install
cp .env.example .env            # defaults: mock LLM, mock SES, Postgres on 5433
docker compose up -d postgres
npm run db:migrate
npm run db:seed                 # creates admin@example.com / ChangeMe!12345 + default instruction docs
npm run dev:api                 # http://localhost:4000
npm run dev:worker              # in a second terminal
npm run dev:web                 # http://localhost:5173 (proxies /api to 4000)
```

In mock mode nothing leaves your machine: the LLM returns deterministic personas/drafts and the
SES gateway returns fake message ids. Switch to the real services by setting `LLM_PROVIDER=anthropic`
(+ `ANTHROPIC_API_KEY`) and `SES_MODE=ses` (+ AWS credentials or an IAM role).

### First campaign

1. **Services** → add your offerings (or import an xlsx with `name, description, target audience,
   value props, proof points, url, tags`).
2. **Instructions** → review/replace the seeded `tone`, `format`, `rules`, `signature` docs and add a
   `company_profile` (what your company does; used in research and drafting).
3. **Settings** → from address, reply-to, configuration set, daily cap, send window, hard rules.
4. **Campaigns → New** → upload the lead sheet, check the header mapping, configure the sequence
   (step delays + guidance), pick services, choose manual or auto approval → Start.
5. **Review** → approve/edit/regenerate/reject drafts. Approved emails are sent within the send
   window and rate limits. Watch the lead page for events, replies and follow-ups.
6. **Export** → download the status workbook (original columns + status/timestamps/message ids).

### Lead sheet headers

Required: `email`. Recognised (case-insensitive, many aliases): `first name`, `last name`, `company`,
`website`, `job title`, `linkedin`, `industry`, `location`, `phone`, `notes`. Any other column is kept as
an extra field, shown to the model, and echoed in the export. See `packages/shared/src/excel.ts`.

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Build shared, API and dashboard |
| `npm run typecheck` | TypeScript across all workspaces |
| `npm test` | API unit + integration tests (needs Postgres on 5433) |
| `npm run test:web` | Dashboard tests |
| `npm run test -w infra/cdk` | CDK synth assertions |
| `npm run db:generate -w apps/api` | Generate a new SQL migration after editing `src/db/schema.ts` |
| `docker compose up --build` | Postgres + API + worker from the production image |

## Configuration

All settings live in `.env` (documented in `.env.example`). Runtime behaviour that operators change
often (from address, caps, send window, hard rules, model) is also editable in the dashboard under
**Settings** and stored in the database; env values act as defaults.

Key switches:

| Variable | Notes |
|---|---|
| `LLM_PROVIDER` | `anthropic` or `mock` |
| `LLM_MODEL` / `LLM_RESEARCH_MODEL` | Default `claude-opus-5` |
| `LLM_WEB_SEARCH` | Use Claude's server-side web search during research |
| `SES_MODE` | `ses` or `mock` (dry run) |
| `SES_CONFIGURATION_SET` | Must have an SNS event destination pointing at `/webhooks/ses/events` |
| `SES_DAILY_CAP`, `SES_MAX_SEND_RATE` | Never exceed the SES account quota; the lower value wins |
| `SNS_ALLOWED_TOPIC_ARNS` | Restrict webhooks to your topics (signatures are always verified in production) |
| `SES_INBOUND_BUCKET` | Bucket used by the SES receipt rule for reply capture |
| `IMAP_*` | Alternative reply capture by polling a mailbox |
| `CLOUDWATCH_METRICS_ENABLED` | Push custom metrics (namespace `MailApp`) |
| `CLOUDWATCH_SES_METRICS_ENABLED` | Pull `AWS/SES` metrics into the dashboard |

## Observability

- Structured JSON logs (pino) with request ids, user ids and job ids → stdout → CloudWatch Logs.
- Custom metrics: `emails_sent`, `send_failures`, `llm_calls`, `llm_latency_ms`, `llm_*_tokens`,
  `research_failures`, `drafts_rejected_by_validator`, `followups_scheduled`, `events_ingested`,
  `bounces`, `complaints`, `replies`, `unsubscribes`, `queue_depth`, `job_failures`.
- SES telemetry: configuration-set events (stored per message), `GetAccount` quotas/enforcement
  status, CloudWatch `AWS/SES` series, and the account-level suppression list (synced every 5 min).
- Every SES `SendEmail` request summary and raw response is stored in `send_attempts`.
- `/healthz`, `/readyz`, `/api/system/status`, and an audit log of every mutating action.

## Security notes

Argon2id passwords, short-lived JWT access cookie + rotating refresh tokens, login lockout, CSRF
header on mutating requests, role-based access (admin / operator / viewer), SNS signature validation,
HMAC unsubscribe tokens, RFC 8058 one-click unsubscribe headers, hard bounce/complaint suppression
mirrored to the SES account list, and validator-enforced do-not-contact domains.
