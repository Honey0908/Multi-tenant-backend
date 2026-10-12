// One-off admin task, run via the "DB Admin (manual)" GitHub Actions workflow
// (or locally) against the hosted Render Postgres instance — not part of the
// app itself. Resets an existing PLATFORM_ADMIN user's password.
//
// The normal seed (prisma/seed.ts) deliberately no-ops once the platform
// admin exists, so it cannot be used to change the password. This script
// hashes a new password with argon2 (same as the seed) and writes it onto
// the existing row.
//
// Why it toggles RLS: every tenant table, "User" included, has FORCE ROW
// LEVEL SECURITY, which applies even to the table owner this DATABASE_URL
// connects as (it is the tables' owner, not a true BYPASSRLS superuser on
// managed Postgres). With no app.org_id set, the tenant_isolation_policy
// matches zero rows, so a plain UPDATE would silently affect 0 rows. We
// briefly disable RLS on "User" inside a single transaction and re-enable it
// before COMMIT, so isolation is never actually left off for other sessions
// (the ALTER TABLE statements take an exclusive lock and are transactional).
import argon2 from 'argon2';
import { Client } from 'pg';

const required = [
  'DATABASE_URL',
  'PLATFORM_ADMIN_EMAIL',
  'PLATFORM_ADMIN_PASSWORD',
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
}

const email = process.env.PLATFORM_ADMIN_EMAIL;
const passwordHash = await argon2.hash(process.env.PLATFORM_ADMIN_PASSWORD);

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query('BEGIN');
  await client.query('ALTER TABLE "User" DISABLE ROW LEVEL SECURITY');

  const result = await client.query(
    `UPDATE "User"
        SET password_hash = $1, updated_at = now()
      WHERE email = $2 AND role = 'PLATFORM_ADMIN'`,
    [passwordHash, email],
  );

  await client.query('ALTER TABLE "User" ENABLE ROW LEVEL SECURITY');

  if (result.rowCount === 0) {
    // Nothing matched — don't commit a no-op that looks like success.
    throw new Error(`No PLATFORM_ADMIN user found with email ${email}`);
  }

  await client.query('COMMIT');
  console.log(`Reset password for platform admin: ${email}`);
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error.message ?? error);
  process.exitCode = 1;
} finally {
  await client.end();
}
