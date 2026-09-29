CREATE TYPE "public"."llm_batch_item_status" AS ENUM('pending', 'submitted', 'succeeded', 'errored', 'expired', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."llm_batch_status" AS ENUM('pending', 'submitted', 'processing', 'completed', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."llm_batch_strategy" AS ENUM('campaign_start', 'rolling');--> statement-breakpoint
CREATE TYPE "public"."llm_provider" AS ENUM('anthropic', 'openai', 'gemini', 'deepseek', 'mock');--> statement-breakpoint
CREATE TYPE "public"."llm_purpose" AS ENUM('research', 'persona', 'draft');--> statement-breakpoint
CREATE TABLE "llm_batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid,
	"campaign_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"custom_id" varchar(120) NOT NULL,
	"purpose" "llm_purpose" NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"model_key" varchar(120) NOT NULL,
	"model" varchar(80) NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "llm_batch_item_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"context" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"error" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid,
	"provider" "llm_provider" NOT NULL,
	"model_key" varchar(120) NOT NULL,
	"model" varchar(80) NOT NULL,
	"purpose" "llm_purpose" NOT NULL,
	"strategy" "llm_batch_strategy" DEFAULT 'rolling' NOT NULL,
	"status" "llm_batch_status" DEFAULT 'pending' NOT NULL,
	"external_id" varchar(200),
	"external_meta" jsonb,
	"request_count" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"errored" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"poll_attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"provider" "llm_provider" PRIMARY KEY NOT NULL,
	"api_key_enc" text NOT NULL,
	"key_hint" varchar(8) DEFAULT '' NOT NULL,
	"base_url" text,
	"last_test_ok" boolean,
	"last_test_at" timestamp with time zone,
	"last_test_message" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "ai_config" jsonb;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "cost_micro_usd" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "research_cost_micro_usd" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "total_cost_micro_usd" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "email_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "provider" "llm_provider" DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "model_key" varchar(120) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "batch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "cost_micro_usd" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_batch_items" ADD CONSTRAINT "llm_batch_items_batch_id_llm_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."llm_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_batch_items" ADD CONSTRAINT "llm_batch_items_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_batch_items" ADD CONSTRAINT "llm_batch_items_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_batches" ADD CONSTRAINT "llm_batches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_batch_items_pending_idx" ON "llm_batch_items" USING btree ("status","campaign_id","purpose","model_key","queued_at");--> statement-breakpoint
CREATE INDEX "llm_batch_items_batch_idx" ON "llm_batch_items" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "llm_batch_items_lead_idx" ON "llm_batch_items" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_batch_items_dedupe_uq" ON "llm_batch_items" USING btree ("lead_id","purpose","step","attempt");--> statement-breakpoint
CREATE INDEX "llm_batches_status_idx" ON "llm_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "llm_batches_campaign_idx" ON "llm_batches" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_batches_external_uq" ON "llm_batches" USING btree ("provider","external_id");--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_calls_campaign_idx" ON "llm_calls" USING btree ("campaign_id","purpose");--> statement-breakpoint
CREATE INDEX "llm_calls_lead_idx" ON "llm_calls" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "llm_calls_model_idx" ON "llm_calls" USING btree ("model_key");--> statement-breakpoint
-- Backfill: rows written before the catalogue existed stored a bare Anthropic model id.
UPDATE "llm_calls" SET "model_key" = 'anthropic:' || "model" WHERE "model_key" = '' AND "model" LIKE 'claude-%';--> statement-breakpoint
UPDATE "llm_calls" SET "model_key" = "model" WHERE "model_key" = '';
