-- The platform-admin surface (listing/inspecting organisations across the
-- whole platform) must not run over the same `app_user` connection the rest
-- of the app uses: `app_user` has full CRUD on every tenant table, which is
-- far more than an admin metadata viewer needs. Following the same
-- least-privilege pattern as `auth_reader` (create_auth_reader_role),
-- `platform_reader` gets SELECT on only the tables that make up "org-level
-- metadata" — Organisation, SubscriptionPlan, and User (the org directory).
--
-- It deliberately has NO grants on Project, Issue, or UsageCounter: even if
-- application code accidentally queried tenant content through this
-- connection, Postgres itself would reject it with a permissions error —
-- defense in depth, not just an application-level check.
--
-- Unlike `auth_reader`, this role does NOT bypass RLS: platform admin routes
-- still set `app.org_id` per request (see withPlatformOrgContext in
-- src/lib/db.ts) when reading a single organisation's users, so the same
-- RLS policy that protects `app_user` queries also protects this role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_reader') THEN
    CREATE ROLE platform_reader LOGIN PASSWORD 'platform_reader' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE taskflow TO platform_reader;
GRANT USAGE ON SCHEMA public TO platform_reader;
GRANT SELECT ON "Organisation", "SubscriptionPlan", "User" TO platform_reader;
