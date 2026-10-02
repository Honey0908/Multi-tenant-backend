// One-off admin task, run via the "DB Admin (manual)" GitHub Actions workflow
// against the hosted Render Postgres instance — not part of the app itself.
// Resets the three restricted roles' passwords away from the values
// hardcoded in prisma/migrations/*_create_*_role (fine for local dev, not
// for production, since those migration files are plaintext in git history).
import { Client } from 'pg';

const required = [
  'DATABASE_URL',
  'APP_USER_PASSWORD',
  'AUTH_READER_PASSWORD',
  'PLATFORM_READER_PASSWORD',
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
await client.query(`ALTER ROLE app_user PASSWORD '${process.env.APP_USER_PASSWORD}'`);
await client.query(`ALTER ROLE auth_reader PASSWORD '${process.env.AUTH_READER_PASSWORD}'`);
await client.query(`ALTER ROLE platform_reader PASSWORD '${process.env.PLATFORM_READER_PASSWORD}'`);
await client.end();

console.log('Rotated app_user / auth_reader / platform_reader passwords.');
