CREATE TABLE "imap_cursors" (
	"account_key" varchar(80) PRIMARY KEY NOT NULL,
	"uid_validity" text,
	"last_uid" integer DEFAULT 0 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "imap_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "imap_host" varchar(253);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "imap_port" integer DEFAULT 993 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "imap_user" varchar(254);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "imap_password_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "imap_mailbox" varchar(200) DEFAULT 'INBOX' NOT NULL;