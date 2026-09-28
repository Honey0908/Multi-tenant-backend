-- Backfills a STORAGE_BYTES UsageCounter row for every organisation that
-- doesn't already have one (i.e. every org created before this milestone).
-- This must be a separate migration from add_attachments: Postgres doesn't
-- let a transaction use an enum value ('STORAGE_BYTES') that the same
-- transaction just added with ALTER TYPE ... ADD VALUE.
--
-- max_limit is the org's plan's max_storage_mb converted to bytes (the unit
-- claimUsage/releaseUsage actually account in — see src/lib/usageCounters.ts).
INSERT INTO "UsageCounter" ("id", "organisation_id", "resource_type", "value", "max_limit", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", 'STORAGE_BYTES', 0, sp."max_storage_mb"::bigint * 1024 * 1024, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organisation" o
JOIN "SubscriptionPlan" sp ON sp."id" = o."plan_id"
WHERE NOT EXISTS (
  SELECT 1 FROM "UsageCounter" uc
  WHERE uc."organisation_id" = o."id" AND uc."resource_type" = 'STORAGE_BYTES'
);
