-- "Organisation" was the one tenant-scoped table left without Row-Level
-- Security, and "SubscriptionPlan" left `app_user` with full write access.
--
-- Nothing exploited either: every service hand-filters by the caller's own
-- org id. But that is exactly the property this codebase is built NOT to
-- rely on — the whole point of RLS here is that a future careless query
-- (`organisation.findMany()` with no filter) must return nothing rather
-- than every tenant on the platform. Before this migration that one query
-- returned every organisation's name and slug, and `app_user` could also
-- UPDATE the plan catalog to raise its own limits.

-- Same policy shape as User/Project/Issue/UsageCounter/Attachment: fails
-- closed to zero rows when app.org_id isn't set, via the current_org_id()
-- guard function (see harden_org_id_policy). The tenant row IS the tenant,
-- so it matches on "id" rather than "organisation_id".
ALTER TABLE "Organisation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organisation" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON "Organisation"
USING ("id" = current_org_id());

-- Platform admins must be able to enumerate organisations they are not a
-- member of — that is their entire job (see create_platform_reader_role).
-- A second policy restricted `TO platform_reader` grants exactly that:
-- Postgres ORs permissive policies together, so `platform_reader` reads
-- every organisation while `app_user` remains confined to its own by the
-- policy above. FOR SELECT keeps it read-only, and `platform_reader` still
-- holds no grants at all on Project/Issue/Attachment, so this widens
-- visibility of org metadata only — never tenant content.
CREATE POLICY platform_read_policy ON "Organisation"
FOR SELECT TO platform_reader
USING (true);

-- "SubscriptionPlan" is a global catalog shared by every tenant, so it is
-- deliberately NOT given RLS — every org must be able to read the plan it
-- is on. What it must not be is writable by the application role: with
-- INSERT/UPDATE/DELETE, a single careless or injected write through
-- `app_user` could raise max_projects/max_users/max_storage_mb for everyone
-- on that tier and quietly void plan enforcement platform-wide. Seeding and
-- plan changes are operational tasks and run as the migration role
-- (see prisma/seed.ts).
REVOKE INSERT, UPDATE, DELETE ON "SubscriptionPlan" FROM app_user;
