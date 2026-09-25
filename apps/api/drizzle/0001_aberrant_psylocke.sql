CREATE TYPE "public"."connector_kind" AS ENUM('imap');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('idle', 'syncing', 'failed');--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kb_id" uuid NOT NULL,
	"kind" "connector_kind" DEFAULT 'imap' NOT NULL,
	"label" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"mailbox" text DEFAULT 'INBOX' NOT NULL,
	"secret" text NOT NULL,
	"include_attachments" boolean DEFAULT true NOT NULL,
	"since_days" integer DEFAULT 90 NOT NULL,
	"uid_validity" text,
	"last_uid" integer DEFAULT 0 NOT NULL,
	"status" "connector_status" DEFAULT 'idle' NOT NULL,
	"error" text,
	"messages_imported" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connectors_kb_id_idx" ON "connectors" USING btree ("kb_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_connector_external_key" ON "documents" USING btree ("connector_id","external_id");