import '../src/env.js';
import { Client } from 'pg';

// Runs as the migration/superuser role (DATABASE_URL) deliberately: it must
// see every organisation's rows at once to audit for cross-tenant leaks,
// which the RLS-scoped app_user/auth_reader/platform_reader roles cannot do
// by design. This is an offline ops check (`npm run audit:leak`), never
// reachable through the API.
//
// A leak here should be structurally impossible — Issue.organisation_id is
// part of a composite FK to Project(organisation_id, id), and
// Attachment.organisation_id is part of a composite FK to
// Issue(organisation_id, id), and ProjectMember / Issue.assignee_id link to
// Project and User the same way (see schema.prisma / enable_rls /
// add_attachments migrations), so Postgres itself rejects a child row whose
// org doesn't match its parent's org. This script is a regression safety
// net for that guarantee, not a replacement for it.
const CHECKS: Array<{ name: string; query: string }> = [
  {
    name: 'Issue.organisation_id vs Project.organisation_id',
    query: `
      SELECT i.id AS issue_id, i.organisation_id AS issue_org, p.organisation_id AS project_org
      FROM "Issue" i
      JOIN "Project" p ON i.project_id = p.id
      WHERE i.organisation_id != p.organisation_id;
    `,
  },
  {
    name: 'Attachment.organisation_id vs Issue.organisation_id',
    query: `
      SELECT a.id AS attachment_id, a.organisation_id AS attachment_org, i.organisation_id AS issue_org
      FROM "Attachment" a
      JOIN "Issue" i ON a.issue_id = i.id
      WHERE a.organisation_id != i.organisation_id;
    `,
  },
  {
    name: 'ProjectMember.organisation_id vs Project.organisation_id',
    query: `
      SELECT pm.id AS member_id, pm.organisation_id AS member_org, p.organisation_id AS project_org
      FROM "ProjectMember" pm
      JOIN "Project" p ON pm.project_id = p.id
      WHERE pm.organisation_id != p.organisation_id;
    `,
  },
  {
    name: 'ProjectMember.organisation_id vs User.organisation_id',
    query: `
      SELECT pm.id AS member_id, pm.organisation_id AS member_org, u.organisation_id AS user_org
      FROM "ProjectMember" pm
      JOIN "User" u ON pm.user_id = u.id
      WHERE pm.organisation_id != u.organisation_id;
    `,
  },
  {
    name: 'Issue.organisation_id vs assignee User.organisation_id',
    query: `
      SELECT i.id AS issue_id, i.organisation_id AS issue_org, u.organisation_id AS assignee_org
      FROM "Issue" i
      JOIN "User" u ON i.assignee_id = u.id
      WHERE i.organisation_id != u.organisation_id;
    `,
  },
  {
    // Not a tenant-boundary check but the invariant the assignment code
    // maintains: an assignee must belong to the issue's project. Nothing in
    // the schema enforces it, so this catches a code path that skips it.
    name: 'Issue assignee without a ProjectMember row',
    query: `
      SELECT i.id AS issue_id, i.project_id, i.assignee_id
      FROM "Issue" i
      WHERE i.assignee_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ProjectMember" pm
          WHERE pm.project_id = i.project_id AND pm.user_id = i.assignee_id
        );
    `,
  },
];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    let failed = false;
    for (const check of CHECKS) {
      const { rows } = await client.query(check.query);
      if (rows.length === 0) {
        console.log(`Leak audit passed: ${check.name} — no mismatches.`);
        continue;
      }

      failed = true;
      console.error(`Leak audit FAILED: ${check.name} — ${rows.length} mismatched row(s).`);
      console.table(rows);
    }
    if (failed) {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
