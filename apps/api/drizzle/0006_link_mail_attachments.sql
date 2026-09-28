-- Attachments already imported are linked to their mail. An attachment's
-- external id is its message's id plus "#<index>", so the parent is the
-- document from the same connector whose external id is that prefix.
UPDATE "documents" AS "child"
SET "parent_id" = "parent"."id"
FROM "documents" AS "parent"
WHERE "child"."connector_id" IS NOT NULL
  AND "child"."parent_id" IS NULL
  AND "child"."connector_id" = "parent"."connector_id"
  AND "child"."external_id" ~ '#[0-9]+$'
  AND "parent"."external_id" = regexp_replace("child"."external_id", '#[0-9]+$', '');
