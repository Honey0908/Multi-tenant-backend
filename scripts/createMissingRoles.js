// One-off admin task, run via the "DB Admin (manual)" GitHub Actions
// workflow. Needed because `prisma migrate resolve --applied` only edits
// Prisma's migration-history bookkeeping — it does not execute the
// migration's SQL. After resolving create_app_role / create_auth_reader_role
// / create_platform_reader_role as applied (to get past their broken
// hardcoded `GRANT CONNECT ON DATABASE taskflow`), the roles those
// migrations were supposed to create never actually existed on Render,
// breaking every later migration that grants something to them.
//
// Mirrors the exact CREATE ROLE statements from those three migrations
// (same IF NOT EXISTS guard), so it's safe to run anywhere, including
// somewhere the roles already exist (local dev).
import { Client } from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

await client.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
      CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
  END
  $$;
`);

// NOT BYPASSRLS here, unlike the original create_auth_reader_role migration:
// granting BYPASSRLS requires the granting role to itself have BYPASSRLS
// (Postgres 16+), which Render's admin connection deliberately doesn't have.
// auth_reader instead gets equivalent access via an explicit RLS policy —
// see the auth_reader_explicit_select_policy migration.
await client.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_reader') THEN
      CREATE ROLE auth_reader LOGIN PASSWORD 'auth_reader' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
  END
  $$;
`);

await client.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_reader') THEN
      CREATE ROLE platform_reader LOGIN PASSWORD 'platform_reader' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
  END
  $$;
`);

await client.end();

console.log('Created app_user / auth_reader / platform_reader roles (if missing).');
console.log('Passwords are still the dev defaults — rotate them with the rotate-passwords command next.');
