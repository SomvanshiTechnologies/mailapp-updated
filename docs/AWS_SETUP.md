# AWS setup and deployment

This guide takes the platform from an empty AWS account to a running deployment with SES events
flowing back into the dashboard. Everything infrastructure-related is defined in `infra/cdk`.

## What you (the operator) need to provide

| Item | Why |
|---|---|
| An AWS account + IAM principal with admin (for CDK bootstrap/deploy) | One-off deployment |
| A domain you control (e.g. `outreach.example.com`) and, ideally, a Route 53 hosted zone | HTTPS for the dashboard and the SNS webhook; DKIM records |
| A verified SES sending domain (`example.com`) and, for replies, an MX record if you use SES inbound | Sending + reply capture |
| SES production access (out of the sandbox) | Sending to unverified recipients |
| An Anthropic API key | Research and drafting |
| Optional: alert email address | Alarm notifications |

For local runs against real SES from your laptop, use the policy in `infra/iam/` instead of the ECS task role.

## 1. Prerequisites

```bash
npm install
npm install -g aws-cdk          # or use npx cdk
aws configure                   # or AWS_PROFILE / SSO
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

## 2. SES

1. **Verify the sending domain** (the CDK Messaging stack can create the identity with Easy DKIM when
   `sendingDomain` is set; it outputs the three DKIM CNAME records to add to DNS).
2. **Request production access** in the SES console (Account dashboard → Request production access).
   Until then you can only send to verified addresses and the daily quota is 200.
3. **Configuration set**: created by CDK (`mailapp-<env>-events`) with an SNS event destination for
   Send, Delivery, Bounce, Complaint, Reject, Open, Click, RenderingFailure, DeliveryDelay and
   Subscription events. The application must send with `SES_CONFIGURATION_SET` set to this name.
4. **Event flow**: SES → SNS topic → HTTPS subscription to `https://<domainName>/webhooks/ses/events`.
   The API confirms the subscription automatically (it fetches `SubscribeURL` after validating the
   SNS signature). The subscription is created by the Messaging stack once `domainName` is set.
5. **Reputation**: keep the bounce rate below 5% and complaints below 0.1%. The Observability stack
   alarms on both; the app suppresses hard bounces and complaints automatically.

### Inbound replies (optional)

Set `inboundEnabled=true` and `sendingDomain`. CDK creates a receipt rule set that stores raw mail in
the inbound bucket and notifies `https://<domainName>/webhooks/ses/inbound`. You must:

- Add an MX record for the reply domain pointing at `inbound-smtp.<region>.amazonaws.com` (SES inbound
  is only available in some regions, e.g. us-east-1, us-west-2, eu-west-1).
- Set the reply-to address in Settings to an address on that domain.
- Activate the receipt rule set in the SES console if it is not the active one.

Alternative without SES inbound: set `IMAP_*` variables to poll an existing mailbox.

## 3. Secrets

The Data stack creates Secrets Manager secrets:

| Secret | Value |
|---|---|
| `mailapp/<env>/db` | RDS master credentials (generated) |
| `mailapp/<env>/DATABASE_URL` | Composed connection string used by the app |
| `mailapp/<env>/JWT_SECRET`, `mailapp/<env>/APP_SECRET` | Generated 64-char secrets |
| `mailapp/<env>/external` | JSON with `ANTHROPIC_API_KEY` and `IMAP_PASSWORD` — **you fill this in** |

```bash
aws secretsmanager put-secret-value --secret-id mailapp/prod/external \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-...","IMAP_PASSWORD":""}'
```

## 4. Deploy

Configure context in `infra/cdk/cdk.json` (or pass `-c key=value`):

```jsonc
"envName": "prod",
"region": "us-east-1",
"account": "123456789012",
"domainName": "outreach.example.com",
"hostedZoneId": "Z0123456789",        // or certificateArn
"sendingDomain": "example.com",
"fromEmail": "outreach@example.com",
"replyTo": "replies@example.com",
"inboundEnabled": true,
"alertEmail": "ops@example.com"
```

Then:

```bash
cd infra/cdk
npx cdk synth
npx cdk deploy MailApp-prod-Network MailApp-prod-Data
npx cdk deploy MailApp-prod-Messaging
npx cdk deploy MailApp-prod-Compute          # builds the Docker image from the repo root
npx cdk deploy MailApp-prod-Observability
```

The Compute stack outputs the ALB DNS name, the ECS cluster/service names and a ready-made
`aws ecs run-task` command for the migration task.

Topology (internal tool, kept minimal): one VPC with no NAT gateway, ALB + Fargate tasks in public
subnets (tasks get a public IP but the security group only admits ALB → 4000), single-AZ RDS in
isolated subnets, no autoscaling (one API task, one worker task). Two AZs exist only because AWS
requires them for an ALB and an RDS subnet group.

## 5. Migrate and seed

```bash
# Migration task (command printed as a stack output)
aws ecs run-task --cluster mailapp-prod --task-definition mailapp-prod-migrate \
  --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=ENABLED}"

# First admin user: run the seed once with SEED_ADMIN_* env overrides
aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"migrate","command":["node","apps/api/dist/db/seed.js"],"environment":[{"name":"SEED_ADMIN_EMAIL","value":"you@example.com"},{"name":"SEED_ADMIN_PASSWORD","value":"<strong password>"}]}]}'
```

Change the seeded password after the first login (Settings → change password) and create the other
users from the Users page.

## 6. DNS

- `A`/alias record for `domainName` → ALB (created automatically when `hostedZoneId` is set).
- DKIM CNAMEs from the Messaging stack outputs.
- Optional custom MAIL FROM domain (MX + TXT) for better alignment.
- MX record for inbound (see above).

### Inbox placement (Primary vs Promotions)

What lands a message in Gmail's Promotions tab is mostly *shape*, not reputation. The app's
**Settings → Inbox placement → Delivery mode** controls it:

| Mode | Headers | Body | Footer | Typical placement |
| --- | --- | --- | --- | --- |
| `personal` (default) | none | plain text; minimal unstyled HTML only when *Track opens* is on | one human sentence ("just reply and let me know, or opt out here: …") + postal address | Primary |
| `bulk` | `List-Unsubscribe` + one-click `List-Unsubscribe-Post` | styled HTML | grey unsubscribe block | Promotions |

Trade-off: SES can only measure opens through an HTML part. In `personal` mode, turning
*Track opens* off sends text-only (best placement, no open events); leaving it on adds a bare
HTML mirror so the open pixel works. Replies and clicks are tracked either way. `bulk` mode is
what Gmail/Yahoo require once you exceed ~5,000 messages/day to their users.

DNS that also feeds the classifier:

- **DMARC**: `_dmarc.<sendingDomain>` TXT `v=DMARC1; p=none; rua=mailto:…` at minimum; move to
  `p=quarantine` once reports look clean.
- **SPF alignment**: SES passes SPF on its own `amazonses.com` MAIL FROM, but DMARC alignment then
  relies on DKIM only. Set a custom MAIL FROM (`mail.<sendingDomain>`: MX → `feedback-smtp.<region>.amazonses.com`,
  TXT `v=spf1 include:amazonses.com ~all`) so SPF aligns too.
- Register the domain in Google Postmaster Tools and ramp volume gradually on a new domain.

### Reply capture

Two mechanisms run side by side; without at least one, replies never reach the app, leads are
never marked *replied* and follow-ups keep going out.

1. **SES inbound domain** (primary). Set `inboundEnabled: true` and `inboundDomain` (e.g.
   `reply.<sendingDomain>`) in `cdk.json`. The Messaging stack creates the receipt rule set (and
   activates it), the Compute stack sets `SES_INBOUND_DOMAIN` and subscribes the inbound topic to
   the API. Add the MX record the stack prints:
   `reply.<domain> MX 10 inbound-smtp.<region>.amazonaws.com`. Campaigns whose owner has not set
   a personal Reply-To then send with `Reply-To: <sender-local-part>@reply.<domain>`; a reply is
   stored on the lead within seconds, follow-ups are cancelled, and (Settings → Reply capture) a
   copy is forwarded to the owner's real mailbox with Reply-To set to the lead.
2. **IMAP polling** (fallback). Users who prefer their own Reply-To enter their mailbox under
   **My profile → Reply polling** (Hostinger: `imap.hostinger.com`, port 993). The worker reads
   each configured mailbox every 2 minutes, read-only (cursor per mailbox, no flags touched).
   Passwords are stored AES-GCM encrypted with `APP_SECRET`. The `IMAP_*` environment variables
   still describe one optional organisation-wide mailbox.

### Per-user sender addresses

Every user can set their own From / Reply-To under **My profile** (admins can set it on the Users
page). If the address is on a domain identity that SES has verified (e.g. `<sendingDomain>`), no
further verification is needed; the app checks this against the SES identity list when the
address is saved and rejects unverified ones. A brand-new domain must be verified in SES first.

## 7. Verify

1. `https://<domainName>/healthz` returns `{"ok":true}`; `/readyz` reports db and queue ok.
2. Log in, open **System**: `sesMode=ses`, `llmProvider=anthropic`, queues healthy, last SES sync set.
3. **Dashboard → SES account** shows quota, send rate and `enforcementStatus: HEALTHY`.
4. In SNS, both subscriptions show *Confirmed* (the API logs `SNS subscription confirmed`).
   Without a confirmed subscription on the events topic, Delivery/Open/Click counts stay at zero in
   the dashboard even though SES's own VDM dashboard shows them: the deploy must run with
   `subscribeWebhooks: true` in `cdk.json` once DNS points at the ALB.
5. Create a one-lead campaign to a mailbox you own, approve the draft, confirm the email arrives with
   working unsubscribe link, and that Delivery/Open events appear on the lead page.
6. Reply to it and confirm the lead flips to *replied* and the follow-up is cancelled.

## Running locally against real AWS

Use `infra/iam/mailapp-dev-policy.json` (see its README), set `SES_MODE=ses`, `AWS_REGION`, credentials
(or `AWS_PROFILE`), `SES_CONFIGURATION_SET`, and expose the webhook publicly (e.g. an ngrok tunnel) via
`PUBLIC_BASE_URL` if you want events during development. Without a public URL you can still send;
events simply will not arrive until the SNS subscription points at a reachable endpoint.
