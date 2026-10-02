-- The app must NOT connect as the migration/superuser role: Postgres
-- superusers always bypass Row-Level Security, regardless of
-- FORCE ROW LEVEL SECURITY. Without this dedicated role, the RLS policies
-- from the previous migration are silently no-ops for the running app.
--
-- `app_user` is the role the Express app connects as (see APP_DATABASE_URL
-- in .env / src/lib/prisma.ts). Migrations keep using the superuser
-- DATABASE_URL, since DDL requires elevated privileges anyway.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE taskflow TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
