# HTTP API contract

Base path: `/api`. All responses are JSON. Types referenced below (`CampaignDto`, `LeadDto`, …)
live in `packages/shared/src/dto.ts`; request schemas live in `packages/shared/src/schemas.ts`.

## Conventions

- **Auth**: cookie based. `POST /api/auth/login` sets `mailapp_access` (JWT, httpOnly, SameSite=Lax, 15 min)
  and `mailapp_refresh` (httpOnly, path `/api/auth`, 14 days). The dashboard must send
  `X-Requested-With: mailapp` on every non-GET request (CSRF guard) and call `POST /api/auth/refresh`
  when it receives `401` with `code: "token_expired"`.
- **Roles**: `admin` (everything), `operator` (campaigns, review, services, instructions, suppressions),
  `viewer` (read-only). A forbidden call returns `403 { error: { code: "forbidden" } }`.
- **Errors**: `{ "error": { "code": string, "message": string, "details"?: unknown } }`.
  Validation errors use `code: "validation_error"` and `details` = zod issues.
- **Pagination**: `?page=1&pageSize=50` → `Paginated<T>`.
- **Dates**: ISO 8601 strings, UTC.

## Auth

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `LoginSchema` | `{ user: UserDto }` (+ cookies) |
| POST | `/api/auth/refresh` | – | `{ user: UserDto }` (rotates cookies) |
| POST | `/api/auth/logout` | – | `{ ok: true }` |
| GET | `/api/auth/me` | – | `{ user: UserDto }` |
| POST | `/api/auth/change-password` | `ChangePasswordSchema` | `{ ok: true }` |

## Users (admin)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/users` | – | `{ items: UserDto[] }` |
| POST | `/api/users` | `CreateUserSchema` | `{ user: UserDto }` |
| PATCH | `/api/users/:id` | `UpdateUserSchema` | `{ user: UserDto }` |

## Settings (GET: all roles, PUT: admin)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/settings` | – | `{ settings: SettingsDto }` |
| PUT | `/api/settings` | `SettingsSchema` | `{ settings: SettingsDto }` |

## Services

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/services` | `?includeInactive=true` | `{ items: ServiceDto[] }` |
| POST | `/api/services` | `ServiceSchema` | `{ service: ServiceDto }` |
| PATCH | `/api/services/:id` | `ServiceSchema.partial()` | `{ service: ServiceDto }` |
| DELETE | `/api/services/:id` | – | `{ ok: true }` (soft: isActive=false) |
| POST | `/api/services/import` | multipart `file` (.xlsx) | `{ imported: number, updated: number, errors: {row,reason}[] }` |

## Instructions

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/instructions` | `?kind=tone&includeInactive=true` | `{ items: InstructionDto[] }` |
| POST | `/api/instructions` | `InstructionSchema` | `{ instruction: InstructionDto }` (new version if same kind+title exists) |
| POST | `/api/instructions/upload` | multipart `file` (.md/.txt/.docx*) + fields `kind`, `title` | `{ instruction: InstructionDto }` |
| PATCH | `/api/instructions/:id` | `{ isActive?: boolean, title?: string }` | `{ instruction: InstructionDto }` |
| DELETE | `/api/instructions/:id` | – | `{ ok: true }` |

\* docx is converted to plain text; formatting is dropped.

## Campaigns

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/campaigns` | `?status=` | `{ items: CampaignDto[] }` |
| POST | `/api/campaigns` | multipart: `file` (.xlsx) + `payload` (JSON string of `CreateCampaignSchema`) | `{ campaign: CampaignDto }` |
| POST | `/api/campaigns/preview` | multipart `file` | `{ headers: string[], mapped: Record<string,string>, unmapped: string[], missingRequired: string[], sampleRows: Record<string,string>[], totalRows: number }` |
| GET | `/api/campaigns/:id` | – | `{ campaign: CampaignDto }` |
| PATCH | `/api/campaigns/:id` | `UpdateCampaignSchema` | `{ campaign: CampaignDto }` |
| POST | `/api/campaigns/:id/start` | – | `{ campaign: CampaignDto, enqueued: number }` |
| POST | `/api/campaigns/:id/pause` | – | `{ campaign: CampaignDto }` |
| POST | `/api/campaigns/:id/resume` | – | `{ campaign: CampaignDto }` |
| POST | `/api/campaigns/:id/archive` | – | `{ campaign: CampaignDto }` |
| DELETE | `/api/campaigns/:id` | – (only draft/archived) | `{ ok: true }` |
| GET | `/api/campaigns/:id/leads` | `LeadListQuerySchema` | `Paginated<LeadDto>` |
| GET | `/api/campaigns/:id/stats` | – | `{ counts: CampaignCounts, timeseries: TimeseriesPoint[] }` |
| GET | `/api/campaigns/:id/cost` | – | `CampaignCostDto` — spend to date, the projection for the remaining work, the by-model breakdown, the resolved AI config and any batch in flight |
| GET | `/api/campaigns/:id/export` | – | xlsx download (`Content-Disposition: attachment`) |
| POST | `/api/campaigns/:id/approve-all` | – | `{ approved: number }` (approves every pending_review email) |

## Leads

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/leads/:id` | – | `{ lead: LeadDetailDto }` |
| POST | `/api/leads/:id/retry` | – | `{ lead: LeadDto }` (re-queues research/draft for failed leads) |
| POST | `/api/leads/:id/skip` | – | `{ lead: LeadDto }` |
| POST | `/api/leads/:id/mark-replied` | `{ note?: string }` | `{ lead: LeadDto }` |
| POST | `/api/leads/:id/unsubscribe` | – | `{ lead: LeadDto }` |
| POST | `/api/leads/:id/research` | – | `{ lead: LeadDto }` (re-run research now) |

## Emails (review queue)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/emails` | `?status=pending_review&campaignId=&page=&pageSize=` | `Paginated<EmailDto & { lead: LeadDto }>` |
| GET | `/api/emails/:id` | – | `{ email: EmailDto, lead: LeadDto, attempts: SendAttemptDto[], events: EmailEventDto[] }` |
| POST | `/api/emails/:id/approve` | `ReviewEmailSchema` (optional edits) | `{ email: EmailDto }` (queues send) |
| POST | `/api/emails/:id/reject` | `{ note?: string }` | `{ email: EmailDto }` |
| POST | `/api/emails/:id/regenerate` | `RegenerateEmailSchema` | `{ email: EmailDto }` (status → draft, re-queued) |
| POST | `/api/emails/:id/send-test` | `{ to: string }` | `{ ok: true, messageId: string }` |

## Suppressions

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/suppressions` | `?search=&page=&pageSize=` | `Paginated<SuppressionDto>` |
| POST | `/api/suppressions` | `SuppressionSchema` | `{ suppression: SuppressionDto }` |
| DELETE | `/api/suppressions/:id` | – | `{ ok: true }` |
| POST | `/api/suppressions/import` | multipart `file` (.xlsx/.csv, column `email`) | `{ imported: number }` |

## Models, providers & batches

Model selections are strings of the form `<provider>:<model>`, optionally suffixed with
`@batch` to route the request through the provider's batch endpoint (half price, results
arrive asynchronously). A campaign stores only the fields it deliberately overrides in
`aiConfig`; anything absent inherits the organisation settings.

Costs are carried everywhere as integer **micro-dollars** (1e-6 USD) so sums stay exact;
`formatUsd()` in `@mailapp/shared` renders them. Every recorded call stores the price it was
charged, so changing a rate never rewrites history.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/api/llm/models` | – | `{ models: ModelOptionDto[], providers: ProviderStatusDto[], researchModes, ratesCapturedAt, mockMode }` — every model, with batch variants, rates after overrides, and whether its provider has a key |
| GET | `/api/llm/providers` | – | `{ providers: ProviderStatusDto[] }` |
| PUT | `/api/llm/providers/:provider` | `ProviderCredentialSchema` (admin) | `{ providers: ProviderStatusDto[] }` — key is encrypted with `APP_SECRET` and never returned |
| DELETE | `/api/llm/providers/:provider` | – (admin) | `{ providers: ProviderStatusDto[] }` — falls back to the environment variable |
| POST | `/api/llm/providers/:provider/test` | – (admin) | `{ ok: boolean, message: string \| null }` |
| POST | `/api/llm/estimate` | `{ leads, steps, researchModel?, draftModel?, researchMode? }` | `{ estimate: CostEstimate, ai: ResolvedAiConfig, ready: { research, draft } }` — projection for a campaign that may not exist yet |
| GET | `/api/llm/batches` | `?status=&campaignId=&limit=` | `{ items: BatchDto[], hasPending: boolean }` |
| POST | `/api/llm/batches/tick` | – (admin) | `{ submitted, polled, applied }` — runs the flush/poll cycle now |
| POST | `/api/llm/batches/cancel` | `{ campaignId }` (admin) | `{ cancelled: number }` — open batches are cancelled and their leads fall back to synchronous jobs |

Research intensity is one of `normal`, `great`, `advance`; each sets the reasoning effort, the
web-search and page-fetch budgets, the agentic iteration cap and the expected token spend used
by the estimator.

## Analytics

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/api/analytics/overview` | `DateRangeQuerySchema` | `OverviewAnalytics` |
| GET | `/api/analytics/timeseries` | `DateRangeQuerySchema` | `{ points: TimeseriesPoint[] }` |
| GET | `/api/analytics/events` | `?campaignId=&type=&page=&pageSize=` | `Paginated<EmailEventDto>` |
| GET | `/api/analytics/ses-account` | – | `SesAccountInfo` |
| GET | `/api/analytics/ses-metrics` | `?hours=24` | `SesMetricsResponse` |
| GET | `/api/analytics/llm-usage` | `DateRangeQuerySchema` | `LlmUsageDto` — calls, tokens, `totalMicroUsd`, cost per sent email and per lead, plus breakdowns by model, by purpose and by day |

## System

| Method | Path | Response |
|---|---|---|
| GET | `/api/system/status` | `SystemStatus` |
| GET | `/api/audit` | `Paginated<AuditLogDto>`. Query: `page`, `pageSize` (max 200), `action` (exact `campaign.start` or group `campaign`), `user` (email substring, or `system`), `entityType`, `entityId`, `from` / `to` (ISO date or date-time; a plain `to` date includes the whole day), `q` (free text over action, user, entity id, IP and metadata) |
| GET | `/api/audit/facets` | `AuditFacets`: distinct `actions`, `entityTypes`, `users` for filter drop-downs |
| GET | `/healthz` | `{ ok: true }` |
| GET | `/readyz` | `{ ok: boolean, db: string, queue: string }` |

## Public / webhooks (no auth)

| Method | Path | Notes |
|---|---|---|
| POST | `/webhooks/ses/events` | SNS delivery of SES configuration-set events. Confirms subscriptions automatically. |
| POST | `/webhooks/ses/inbound` | SNS notification from an SES receipt rule (S3 action). |
| GET | `/u/:token` | Unsubscribe landing page (confirms). |
| POST | `/u/:token` | RFC 8058 one-click unsubscribe (`List-Unsubscribe=One-Click`). |

## Dashboard hosting

In production the API serves the built dashboard from `apps/web/dist` at `/` with an SPA fallback,
so the web app can use relative URLs (`/api/...`). In development Vite proxies `/api`, `/u`, `/webhooks`
to `http://localhost:4000`.
