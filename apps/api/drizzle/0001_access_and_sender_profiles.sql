CREATE TYPE "public"."campaign_access_level" AS ENUM('view', 'edit', 'full');--> statement-breakpoint
CREATE TYPE "public"."dashboard_scope" AS ENUM('own', 'all');--> statement-breakpoint
CREATE TABLE "campaign_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"level" "campaign_access_level" DEFAULT 'view' NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "sender_user_id" uuid;--> statement-breakpoint
ALTER TABLE "instruction_docs" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "from_email" varchar(254);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "from_name" varchar(120);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reply_to" varchar(254);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "postal_address" varchar(300);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dashboard_scope" "dashboard_scope" DEFAULT 'own' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_access" ADD CONSTRAINT "campaign_access_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_access" ADD CONSTRAINT "campaign_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_access" ADD CONSTRAINT "campaign_access_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_access_uq" ON "campaign_access" USING btree ("campaign_id","user_id");--> statement-breakpoint
CREATE INDEX "campaign_access_user_idx" ON "campaign_access" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_docs" ADD CONSTRAINT "instruction_docs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "emails_sender_user_idx" ON "emails" USING btree ("sender_user_id","sent_at");--> statement-breakpoint
CREATE INDEX "instruction_docs_owner_idx" ON "instruction_docs" USING btree ("owner_id");