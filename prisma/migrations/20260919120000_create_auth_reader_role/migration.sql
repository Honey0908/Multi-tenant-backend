-- Login needs to find a user by email before their orgId is known, which
-- RLS on "User" structurally forbids (see harden_org_id_policy). Rather than
-- have the app fall back to the migration superuser role for this lookup —
-- which would grant it full read/write on every table — create a narrow
-- role that can only SELECT from "User" and bypasses RLS to do it.
--
-- `auth_reader` is used exclusively by the login handler (see
-- src/lib/authPrisma.ts / AUTH_DATABASE_URL). Every other query in the app
-- continues to go through `app_user`, fully RLS-scoped.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_reader') THEN
    CREATE ROLE auth_reader LOGIN PASSWORD 'auth_reader' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE taskflow TO auth_reader;
GRANT USAGE ON SCHEMA public TO auth_reader;
GRANT SELECT ON "User" TO auth_reader;
