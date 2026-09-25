CREATE TYPE "public"."approval_mode" AS ENUM('manual', 'auto');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."email_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('draft', 'pending_review', 'approved', 'rejected', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed');--> statement-breakpoint
CREATE TYPE "public"."file_kind" AS ENUM('leads_upload', 'services_upload', 'instruction_upload', 'suppression_upload', 'export', 'inbound_raw');--> statement-breakpoint
CREATE TYPE "public"."instruction_kind" AS ENUM('company_profile', 'tone', 'format', 'rules', 'signature', 'followup_guidance', 'other');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('pending', 'researching', 'researched', 'drafting', 'pending_review', 'approved', 'scheduled', 'sending', 'sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced', 'complained', 'unsubscribed', 'suppressed', 'invalid', 'rejected', 'failed', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."ses_event_type" AS ENUM('Send', 'Delivery', 'Bounce', 'Complaint', 'Reject', 'Open', 'Click', 'RenderingFailure', 'DeliveryDelay', 'Subscription');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('hard_bounce', 'complaint', 'unsubscribe', 'manual', 'ses_account_list');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'operator', 'viewer');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"user_email" varchar(254),
	"action" varchar(120) NOT NULL,
	"entity_type" varchar(60),
	"entity_id" varchar(80),
	"metadata" jsonb,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"approval_mode" "approval_mode" DEFAULT 'manual' NOT NULL,
	"sequence" jsonb NOT NULL,
	"service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"from_email" varchar(254),
	"from_name" varchar(120),
	"reply_to" varchar(254),
	"extra_guidance" text DEFAULT '' NOT NULL,
	"hard_rules_override" jsonb,
	"source_file_id" uuid,
	"source_file_name" text,
	"header_map" jsonb,
	"original_headers" jsonb,
	"import_summary" jsonb,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_send_counters" (
	"day" varchar(10) PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_id" uuid,
	"lead_id" uuid,
	"campaign_id" uuid,
	"ses_message_id" varchar(200) NOT NULL,
	"event_type" "ses_event_type" NOT NULL,
	"sub_type" varchar(80),
	"dedupe_key" varchar(300) NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step" integer DEFAULT 1 NOT NULL,
	"direction" "email_direction" DEFAULT 'outbound' NOT NULL,
	"status" "email_status" DEFAULT 'draft' NOT NULL,
	"from_email" varchar(254),
	"to_email" varchar(254) NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"ses_message_id" varchar(200),
	"message_id_header" varchar(300),
	"in_reply_to" varchar(300),
	"references_header" text,
	"llm_meta" jsonb,
	"validation" jsonb,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"raw_send_response" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "file_kind" NOT NULL,
	"storage" varchar(10) NOT NULL,
	"key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" varchar(120),
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" varchar(20) NOT NULL,
	"external_id" varchar(300) NOT NULL,
	"from_email" varchar(254),
	"to_email" varchar(254),
	"subject" text,
	"body_text" text,
	"message_id_header" varchar(300),
	"in_reply_to" varchar(300),
	"references_header" text,
	"matched_lead_id" uuid,
	"matched_email_id" uuid,
	"match_method" varchar(40),
	"is_auto_reply" boolean DEFAULT false NOT NULL,
	"raw_file_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruction_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "instruction_kind" NOT NULL,
	"title" varchar(160) NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"email" varchar(254) NOT NULL,
	"first_name" varchar(120),
	"last_name" varchar(120),
	"company" varchar(200),
	"website" text,
	"job_title" varchar(200),
	"linkedin_url" text,
	"industry" varchar(120),
	"location" varchar(200),
	"phone" varchar(60),
	"notes" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "lead_status" DEFAULT 'pending' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"next_action_at" timestamp with time zone,
	"persona" jsonb,
	"research_raw" jsonb,
	"matched_services" jsonb,
	"last_error" text,
	"unsubscribe_token" varchar(128) NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"complained_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid,
	"campaign_id" uuid,
	"purpose" varchar(40) NOT NULL,
	"model" varchar(80) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"stop_reason" varchar(40),
	"ok" boolean DEFAULT true NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "send_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"error" jsonb,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text NOT NULL,
	"target_audience" text DEFAULT '' NOT NULL,
	"value_props" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proof_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ses_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(40) NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"note" text,
	"source" varchar(80),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"name" varchar(120) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'operator' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_source_file_id_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_matched_lead_id_leads_id_fk" FOREIGN KEY ("matched_lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_matched_email_id_emails_id_fk" FOREIGN KEY ("matched_email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_raw_file_id_files_id_fk" FOREIGN KEY ("raw_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_docs" ADD CONSTRAINT "instruction_docs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_events_dedupe_uq" ON "email_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "email_events_message_idx" ON "email_events" USING btree ("ses_message_id");--> statement-breakpoint
CREATE INDEX "email_events_type_time_idx" ON "email_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "email_events_campaign_idx" ON "email_events" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "emails_lead_idx" ON "emails" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "emails_campaign_status_idx" ON "emails" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "emails_ses_message_idx" ON "emails" USING btree ("ses_message_id");--> statement-breakpoint
CREATE INDEX "emails_message_id_header_idx" ON "emails" USING btree ("message_id_header");--> statement-breakpoint
CREATE INDEX "emails_status_idx" ON "emails" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_messages_external_uq" ON "inbound_messages" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "instruction_docs_kind_idx" ON "instruction_docs" USING btree ("kind","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_campaign_email_uq" ON "leads" USING btree ("campaign_id","email");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_next_action_idx" ON "leads" USING btree ("next_action_at");--> statement-breakpoint
CREATE INDEX "leads_email_idx" ON "leads" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_unsub_token_uq" ON "leads" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "send_attempts_email_idx" ON "send_attempts" USING btree ("email_id");