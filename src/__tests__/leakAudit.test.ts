import { describe, it, expect } from 'vitest';
import { Client } from 'pg';
import request from 'supertest';
import { app, signupOrg } from './helpers.js';

// Runs the same cross-tenant leak query as scripts/leakAudit.ts, over the
// migration/superuser role (the only connection that can see every org's
// rows at once). This should always find zero rows — the composite FK
// Issue(organisation_id, project_id) -> Project(organisation_id, id) makes
// a mismatch structurally impossible — but it's cheap insurance against a
// future schema change accidentally weakening that constraint.
describe('cross-tenant leak audit', () => {
  it('finds zero issues whose organisation_id disagrees with their project\'s', async () => {
    const org = await signupOrg('leak-audit');
    const auth = { Authorization: `Bearer ${org.token}` };
    const project = await request(app).post('/api/projects').set(auth).send({ name: 'Leak Audit Project' });
    await request(app)
      .post(`/api/projects/${project.body.id}/issues`)
      .set(auth)
      .send({ title: 'Leak Audit Issue' });

    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(`
        SELECT i.id FROM "Issue" i
        JOIN "Project" p ON i.project_id = p.id
        WHERE i.organisation_id != p.organisation_id;
      `);
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
