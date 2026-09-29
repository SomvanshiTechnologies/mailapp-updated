# Outreach Engine – Architecture & Delivery Plan

Internal, production-grade cold-outreach platform: upload a lead sheet, research every
lead, match services, draft a personalised email, send through Amazon SES, track every
delivery event, run follow-ups, and report everything back on a secure dashboard.

## 1. Goals

| # | Requirement | How it is met |
|---|-------------|---------------|
| 1 | Upload Excel with known headers | `exceljs` parser + header-alias map + row validation + dedupe + suppression check |
| 2 | Row-by-row research + persona | Worker job per lead; Claude with server-side `web_search`/`web_fetch` tools; structured persona JSON |
| 3 | Match uploaded services, pitch | Services catalogue in DB; LLM ranks fit and produces a pitch angle with rationale |
| 4 | Draft email per instructions/tone/rules | Instruction docs (tone/format/rules/signature/company profile) injected into a cached prompt prefix; deterministic rule validator runs on every draft |
| 5 | Send via SES, capture API response | SES v2 `SendEmail` with configuration set + tags; raw response and every attempt persisted |
| 6 | Log to dashboard + status Excel | Every state change is in Postgres; export builds original sheet + status columns |
| 7 | Follow-up flow | Per-campaign sequence (steps, delays, guidance); cron tick schedules threaded follow-ups; stops on reply/bounce/complaint/unsubscribe |
| 8 | SES telemetry (bounces, complaints, opens, clicks …) | SES event destination → SNS → signed webhook; plus CloudWatch `AWS/SES` metrics and `GetAccount` quotas pulled into the dashboard |
| 9 | Observability | pino JSON logs → CloudWatch Logs, custom CloudWatch metrics, request IDs, health probes, audit log, alarms |
| 10 | Secure login, hosted on AWS | Argon2 passwords, JWT httpOnly cookies, roles, lockout, rate limits; CDK stack for ECS Fargate + RDS + ALB + S3 + SNS |
| 11 | Know and control what the AI costs | Per-call pricing stored in micro-dollars; cost per email, per lead and per campaign; pre-flight estimate; optional spend cap that blocks a campaign start |
| 12 | Choose the model per campaign | Catalogue of Claude / OpenAI / Gemini / DeepSeek models with published rates; campaign-level override or inherit from the organisation; batch variants at half price; three research intensities (normal / great / advance) |

## 2. Stack

- **Language**: TypeScript everywhere (Node 20+ runtime).
- **API/Worker**: Fastify 5, Drizzle ORM (Postgres), pg-boss (Postgres-backed job queue, no Redis), pino.
- **Models**: multi-provider behind one router — `@anthropic-ai/sdk` (default `anthropic:claude-opus-5-5`), `openai` (also serves DeepSeek via its OpenAI-compatible endpoint), `@google/genai`. Adaptive thinking / reasoning effort, structured outputs, prompt caching for the stable prefix (services + instructions), server-side web search/fetch for research. Every provider's **batch endpoint** is supported at half price via a queue-and-poll layer. Keys resolve from the database first (encrypted, editable in the dashboard) then the environment.
- **Cost**: every model call is priced at the moment it is made and stored in micro-dollars, rolled up per lead, per email and per campaign, with a pre-flight estimator and an optional per-campaign spend cap.
- **Email**: `@aws-sdk/client-sesv2`. Events via SNS (`sns-validator` signature check). Inbound replies via SES receipt rule → S3 → SNS, parsed with `mailparser`; optional IMAP poller.
- **Dashboard**: React 18 + Vite + TanStack Query + React Router + Tailwind + Recharts.
- **Infra**: AWS CDK v2 (TypeScript). Docker multi-stage image; docker-compose for local.
- **Tests**: Vitest (unit + integration against real Postgres), `aws-sdk-client-mock`, mock LLM provider, end-to-end pipeline test in dry-run mode.

## 3. Repository layout

```
mailapp/
  PLAN.md                     this document
  docs/                       runbooks: AWS setup, IAM, SES, operations, API
  packages/shared/            zod schemas + types shared by api and web
  apps/api/                   Fastify API + worker (same image, different entrypoint)
    src/config.ts             env validation
    src/db/                   drizzle schema + migrations
    src/modules/auth          login, sessions, users, RBAC
    src/modules/excel         import/export
    src/modules/services      service catalogue
    src/modules/instructions  tone/format/rules docs
    src/modules/campaigns     campaign lifecycle + leads
    src/modules/pipeline      research → match → draft → validate
    src/modules/llm           model catalogue + pricing, provider adapters (anthropic/openai/gemini/deepseek/mock),
                              credential store, prompts, batch queue + runner
    src/modules/ses           sender, rate limiter, event ingestion, inbound, account sync
    src/modules/followups     sequence scheduler
    src/modules/analytics     app metrics + SES/CloudWatch metrics
    src/modules/observability logger, metrics, request context
    src/jobs/                 pg-boss queue definitions + handlers
    test/                     unit + integration + e2e
  apps/web/                   React dashboard
  infra/cdk/                  CDK app (VPC, RDS, ECS, ALB, S3, SNS, SES, CloudWatch)
  infra/iam/                  IAM policy JSON for local/dev credentials
  docker-compose.yml, Dockerfile
```

## 4. Data model (Postgres)

users, refresh_tokens, audit_logs, settings, services, instruction_docs, files,
campaigns, leads, emails, send_attempts, email_events, suppressions, inbound_messages.
pg-boss owns its own `pgboss` schema for jobs.

Lead status machine:

```
pending → researching → drafting → pending_review → approved → scheduled → sending → sent
 sent → delivered → opened → clicked → replied (terminal, sequence stops)
 any  → bounced | complained | unsubscribed | failed | rejected | suppressed | invalid | completed
```

Email (message) status: draft → pending_review → approved → queued → sending → sent → delivered / bounced / complained / failed; rejected.

## 5. Pipeline

1. **Import**: parse xlsx, map headers, validate emails, dedupe within sheet and against suppressions, create leads.
2. **Start campaign**: enqueue `lead.research` per lead, throttled by concurrency setting.
3. **Research** (`lead.research`): fetch website + LLM web search → persona JSON (company summary, offering, size/industry signals, person role, likely priorities, pain points, recent news, confidence). Stored on the lead.
4. **Match + draft** (`lead.draft`): one LLM call with cached prefix (company profile, services catalogue, tone/format/rules) → chosen services with rationale, pitch angle, subject, body (text + minimal HTML). Deterministic validator: word limits, banned phrases, required elements, placeholders, unsubscribe footer. Failing drafts are regenerated once with the validator feedback, then flagged.
5. **Review**: manual mode → dashboard queue (edit/approve/reject/regenerate); auto mode → approved immediately.
6. **Send** (`email.send`): send-window and daily-cap checks, token-bucket rate limit from SES `MaxSendRate`, suppression re-check, SES `SendEmail` with configuration set, tags (campaign, lead, step), `List-Unsubscribe` + one-click header, our own `Message-ID`. Response persisted; lead/email status updated; metric emitted.
7. **Events**: SNS → `/webhooks/ses/events` (signature verified, idempotent by dedupe key). Bounce (Permanent) / Complaint → suppression + stop sequence. Delivery/Open/Click update statuses.
8. **Replies**: `/webhooks/ses/inbound` (S3 raw MIME) or IMAP poller → match `In-Reply-To`/`References`/sender → `replied`, sequence stops, reply stored and shown in the lead thread.
9. **Follow-ups** (`followup.tick` every minute): for leads with no reply/bounce and `next_action_at <= now`, enqueue `lead.draft` for the next step; follow-ups thread on the original message.
10. **Export**: xlsx with original columns + status, step, sent/delivered/opened/clicked/replied timestamps, SES message id, last error.
11. **SES sync** (`ses.sync` every 5 min): `GetAccount` (quota, send rate, enforcement status), CloudWatch `AWS/SES` metrics per configuration set, suppression list reconciliation.

## 6. Security

Argon2id password hashing, JWT (15 min) in httpOnly/SameSite cookie + rotating refresh tokens, login rate limit + lockout, roles (admin / operator / viewer), CSRF protection via SameSite + custom header, SNS signature validation, unsubscribe tokens (HMAC), secrets from env/Secrets Manager, no secrets in logs, audit log for every mutating action, helmet headers, file-type and size validation on uploads.

## 7. Observability

- pino structured logs with request id, user id, job id → stdout → CloudWatch Logs (awslogs driver).
- Custom CloudWatch metrics (namespace `MailApp`): emails_sent, send_failures, llm_calls, llm_latency_ms, llm_tokens, research_failures, drafts_rejected_by_validator, followups_scheduled, queue_depth.
- SES metrics pulled back: Send, Delivery, Bounce, Complaint, Reject, Open, Click, RenderingFailure, DeliveryDelay + account quotas + reputation.
- `/healthz` (liveness), `/readyz` (DB + queue), `/api/system/status` (queues, last sync, SES enforcement).
- CDK alarms: bounce rate > 5 %, complaint rate > 0.1 %, worker task failures, API 5xx.

## 8. Test strategy

- Unit: excel header mapping/validation, rule validator, sequence scheduler, event mapper, reply matcher, rate limiter, unsubscribe tokens, prompt builders, status machine.
- Integration (real Postgres in Docker, mocked SES/LLM): auth flow, campaign create/import, review/approve, send, webhook ingestion, follow-up scheduling, export.
- End-to-end dry-run: full pipeline with `LLM_PROVIDER=mock` and `SES_MODE=mock`.
- Live-AWS checklist (run once IAM is provided): SES identity, config set, SNS subscription confirmation, real send to a verified address, event round-trip.

## 9. Delivery phases

1. Scaffold, shared schemas, DB schema, config, auth, observability.
2. Import/export, services, instructions, campaigns.
3. LLM research/match/draft + validator (real + mock provider).
4. SES send, events, inbound, suppression, follow-ups, analytics, SES sync.
5. Dashboard.
6. Infra (CDK, Docker, IAM docs).
7. Tests + end-to-end run + docs.
