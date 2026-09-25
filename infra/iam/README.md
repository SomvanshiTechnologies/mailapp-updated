# IAM for local / developer runs

`mailapp-dev-policy.json` grants exactly what the application needs to run **outside** AWS (your
laptop, a CI runner) against real SES, CloudWatch and S3. It mirrors the ECS task role created by the
CDK `MailApp-<env>-Compute` stack. In AWS itself the ECS task role is used and no static keys exist.

## 1. Fill in the placeholders

| Placeholder | Value |
|---|---|
| `${AWS_REGION}` | Region where SES is set up, e.g. `us-east-1` |
| `${AWS_ACCOUNT_ID}` | 12-digit account id (`aws sts get-caller-identity --query Account --output text`) |
| `${STORAGE_BUCKET}` | Bucket for uploads/exports (`StorageBucketName` output of the Data stack, or any bucket you create) |
| `${INBOUND_BUCKET}` | Bucket receiving inbound mail (`InboundBucketName` output). Use the storage bucket again if inbound is disabled |

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export STORAGE_BUCKET=my-mailapp-storage
export INBOUND_BUCKET=my-mailapp-inbound
envsubst < infra/iam/mailapp-dev-policy.json > /tmp/mailapp-dev-policy.json
```

(On Windows PowerShell, open the file and replace the four placeholders by hand.)

## 2. Create the policy and a principal

**Preferred: an IAM role you assume with short-lived credentials**

```bash
aws iam create-policy --policy-name MailAppDev --policy-document file:///tmp/mailapp-dev-policy.json
# Trust your own user / SSO role; then:
aws iam attach-role-policy --role-name MailAppDev --policy-arn arn:aws:iam::${AWS_ACCOUNT_ID}:policy/MailAppDev
```

With AWS SSO / `aws configure sso`, simply attach `MailAppDev` to the permission set you use and run the
app with `AWS_PROFILE=<profile>` and no static keys in `.env`.

**Fallback: an IAM user with access keys (rotate regularly)**

```bash
aws iam create-user --user-name mailapp-dev
aws iam attach-user-policy --user-name mailapp-dev --policy-arn arn:aws:iam::${AWS_ACCOUNT_ID}:policy/MailAppDev
aws iam create-access-key --user-name mailapp-dev
```

## 3. Put credentials into `.env`

```
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...            # leave empty when using AWS_PROFILE / an instance role
AWS_SECRET_ACCESS_KEY=...
SES_MODE=ses
SES_CONFIGURATION_SET=mailapp-prod-events
SES_FROM_EMAIL=outreach@yourdomain.com
STORAGE_DRIVER=s3
STORAGE_S3_BUCKET=my-mailapp-storage
CLOUDWATCH_METRICS_ENABLED=true
CLOUDWATCH_SES_METRICS_ENABLED=true
```

The AWS SDK resolves credentials in the usual order (env vars → shared config/SSO profile → instance /
task role), so leaving the two key variables empty is the recommended setup wherever a role is available.

## 4. Verify

```bash
aws ses get-account --region $AWS_REGION            # SES v2: quota + enforcement status
aws s3 ls s3://$STORAGE_BUCKET/                      # bucket access
aws cloudwatch list-metrics --namespace AWS/SES --region $AWS_REGION | head
```

Then start the API with `SES_MODE=ses` and open **Dashboard → System** — the "SES account" card must show
the quota and *sending enabled* without an error.

## What is deliberately not granted

- `ses:*` on identities/config sets (creating or deleting identities is an infra concern done via CDK/console).
- `sns:Publish` (SNS only calls *into* the app).
- Anything on RDS or Secrets Manager outside `mailapp/*`.
- `iam:*`, `ecs:*`, `cloudformation:*` — deployments use your own admin/CDK credentials, never the app's.
