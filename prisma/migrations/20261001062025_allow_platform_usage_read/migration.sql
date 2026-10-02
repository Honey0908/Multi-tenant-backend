-- The planned organisation list screen ("name, plan, aggregate usage,
-- status" — see docs/plan.md) needs per-org usage alongside metadata, which
-- reverses the deliberate choice in add_usage_counters to keep
-- "UsageCounter" out of `platform_reader`'s grants ("operational/billing
-- data, not org-level metadata"). That boundary was right for the
-- organisation-detail and user-listing routes, which never needed it; the
-- list screen does, so `platform_reader` now gets the same narrow,
-- read-only, SELECT-only access it already has to Organisation/User,
-- nothing more — still no grants on Project, Issue, or Attachment.
GRANT SELECT ON "UsageCounter" TO platform_reader;

-- Same shape as "platform_read_policy" on "Organisation" (add_organisation_rls):
-- Postgres ORs permissive policies, so `platform_reader` can read every
-- org's counters across the whole platform while `app_user` stays confined
-- to its own org by the existing tenant_isolation_policy.
CREATE POLICY platform_read_policy ON "UsageCounter"
FOR SELECT TO platform_reader
USING (true);
