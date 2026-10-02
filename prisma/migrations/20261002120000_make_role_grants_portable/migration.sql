-- create_app_role / create_auth_reader_role / create_platform_reader_role
-- each hardcoded `GRANT CONNECT ON DATABASE taskflow`, assuming the database
-- is always named "taskflow". True for local dev, not true for a managed
-- Postgres instance (e.g. Render) that assigns its own database name — on
-- those, the original GRANT targeted a database that doesn't exist and
-- failed, which also meant every statement after it in that same migration
-- file never ran either (the schema/table grants, not just CONNECT).
--
-- GRANT requires a literal identifier, not an expression, so dynamic SQL via
-- `format(...)` is needed to target whatever database this migration is
-- actually running against. The statements below repeat in full (not just
-- the CONNECT grant) so this migration fully completes the intended end
-- state regardless of where the original one stopped — safe to re-run
-- anywhere, since every GRANT/ALTER DEFAULT PRIVILEGES here is idempotent.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_user', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO auth_reader', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO platform_reader', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

GRANT USAGE ON SCHEMA public TO auth_reader;
GRANT SELECT ON "User" TO auth_reader;

GRANT USAGE ON SCHEMA public TO platform_reader;
GRANT SELECT ON "Organisation", "SubscriptionPlan", "User" TO platform_reader;
