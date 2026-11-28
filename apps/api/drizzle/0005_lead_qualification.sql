CREATE TYPE "public"."qualification_status" AS ENUM('qualified', 'unqualified', 'needs_research', 'human_review');--> statement-breakpoint
ALTER TYPE "public"."instruction_kind" ADD VALUE 'targeting_criteria' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."lead_status" ADD VALUE 'qualifying';--> statement-breakpoint
ALTER TYPE "public"."lead_status" ADD VALUE 'qualified';--> statement-breakpoint
ALTER TYPE "public"."lead_status" ADD VALUE 'unqualified';--> statement-breakpoint
ALTER TYPE "public"."lead_status" ADD VALUE 'on_hold';--> statement-breakpoint
ALTER TYPE "public"."llm_purpose" ADD VALUE 'qualify';--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "qualification_status" "qualification_status";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "qualification" jsonb;