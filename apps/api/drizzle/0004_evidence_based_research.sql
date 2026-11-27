CREATE TYPE "public"."research_status" AS ENUM('complete', 'partial', 'failed');--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "research_status" "research_status";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "research_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;