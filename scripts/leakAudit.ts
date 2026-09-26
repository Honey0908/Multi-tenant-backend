import '../src/env.js';
import { Client } from 'pg';

// Runs as the migration/superuser role (DATABASE_URL) deliberately: it must
// see every organisation's rows at once to audit for cross-tenant leaks,
// which the RLS-scoped app_user/auth_reader/platform_reader roles cannot do
// by design. This is an offline ops check (`npm run audit:leak`), never
// reachable through the API.
//
// A leak here should be structurally impossible — Issue.organisation_id is
// part of a composite FK to Project(organisation_id, id) (see schema.prisma
// / enable_rls migration), so Postgres itself rejects an Issue row whose
// org doesn't match its parent Project's org. This script is a regression
// safety net for that guarantee, not a replacement for it.
const LEAK_QUERY = `
  SELECT i.id AS issue_id, i.organisation_id AS issue_org, p.organisation_id AS project_org
  FROM "Issue" i
  JOIN "Project" p ON i.project_id = p.id
  WHERE i.organisation_id != p.organisation_id;
`;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query(LEAK_QUERY);
    if (rows.length === 0) {
      console.log('Leak audit passed: no Issue rows found with a mismatched organisation_id.');
      return;
    }

    console.error(`Leak audit FAILED: ${rows.length} issue(s) have an organisation_id mismatch with their project.`);
    console.table(rows);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
