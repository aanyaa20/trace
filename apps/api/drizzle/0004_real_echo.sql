ALTER TYPE "public"."block_source" ADD VALUE 'vision';--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "visual" jsonb;