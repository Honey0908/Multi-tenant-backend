import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, signupOrg } from './helpers.js';
import { withOrgContext } from '../lib/db.js';

/** Reads an org's live UsageCounter values, keyed by resource type. */
async function counters(orgId: string): Promise<Record<string, number>> {
  return withOrgContext(orgId, async (tx) => {
    const rows = await tx.usageCounter.findMany({ where: { organisation_id: orgId } });
    return Object.fromEntries(rows.map((r) => [r.resource_type, Number(r.value)]));
  });
}

async function createProject(auth: Record<string, string>, name: string) {
  const res = await request(app).post('/api/projects').set(auth).send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createIssue(auth: Record<string, string>, projectId: string, title: string) {
  const res = await request(app).post(`/api/projects/${projectId}/issues`).set(auth).send({ title });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// Deleting a parent used to leave its children's quota claimed forever: the
// rows vanished down the FK cascade without the app ever learning how many
// there were, so an org slowly lost task slots and storage headroom it could
// never reclaim. These pin the accounting to what was actually deleted.
describe('quota released by cascading deletes', () => {
  it('releases every task slot held by a deleted project\'s issues', async () => {
    const org = await signupOrg('cascade-tasks');
    const auth = { Authorization: `Bearer ${org.token}` };

    const projectId = await createProject(auth, 'Doomed');
    for (const title of ['one', 'two', 'three']) {
      await createIssue(auth, projectId, title);
    }
    expect((await counters(org.organisationId)).TASKS).toBe(3);

    expect((await request(app).delete(`/api/projects/${projectId}`).set(auth)).status).toBe(204);

    const after = await counters(org.organisationId);
    expect(after.PROJECTS).toBe(0);
    expect(after.TASKS).toBe(0);

    // And the counter agrees with what's actually left in the table.
    const issuesLeft = await withOrgContext(org.organisationId, (tx) => tx.issue.count());
    expect(issuesLeft).toBe(0);
  });

  it('releases storage bytes held by attachments under a deleted issue', async () => {
    const org = await signupOrg('cascade-storage');
    const auth = { Authorization: `Bearer ${org.token}` };

    const projectId = await createProject(auth, 'With attachments');
    const issueId = await createIssue(auth, projectId, 'Has a file');

    const reserve = await request(app)
      .post(`/api/projects/${projectId}/issues/${issueId}/attachments/reserve`)
      .set(auth)
      .send({ fileName: 'notes.txt', contentType: 'text/plain', sizeBytes: 5000 });
    expect(reserve.status).toBe(201);
    expect((await counters(org.organisationId)).STORAGE_BYTES).toBe(5000);

    expect((await request(app).delete(`/api/projects/${projectId}/issues/${issueId}`).set(auth)).status).toBe(204);

    const after = await counters(org.organisationId);
    expect(after.STORAGE_BYTES).toBe(0);
    expect(after.TASKS).toBe(0);
  });

  it('releases storage bytes two levels down, when the project above them is deleted', async () => {
    const org = await signupOrg('cascade-deep');
    const auth = { Authorization: `Bearer ${org.token}` };

    const projectId = await createProject(auth, 'Deep');
    const issueId = await createIssue(auth, projectId, 'Nested');
    await request(app)
      .post(`/api/projects/${projectId}/issues/${issueId}/attachments/reserve`)
      .set(auth)
      .send({ fileName: 'deep.txt', contentType: 'text/plain', sizeBytes: 4096 });
    expect((await counters(org.organisationId)).STORAGE_BYTES).toBe(4096);

    expect((await request(app).delete(`/api/projects/${projectId}`).set(auth)).status).toBe(204);

    const after = await counters(org.organisationId);
    expect(after.STORAGE_BYTES).toBe(0);
    expect(after.TASKS).toBe(0);
    expect(after.PROJECTS).toBe(0);
  });

  it('frees the slots for reuse, not just on paper', async () => {
    const org = await signupOrg('cascade-reuse');
    const auth = { Authorization: `Bearer ${org.token}` };

    // Starter allows 3 projects. Fill, delete one (with issues under it), refill.
    const first = await createProject(auth, 'p1');
    await createProject(auth, 'p2');
    await createProject(auth, 'p3');
    await createIssue(auth, first, 'child');

    const atLimit = await request(app).post('/api/projects').set(auth).send({ name: 'p4' });
    expect(atLimit.status).toBe(409);

    expect((await request(app).delete(`/api/projects/${first}`).set(auth)).status).toBe(204);

    const afterDelete = await request(app).post('/api/projects').set(auth).send({ name: 'p4' });
    expect(afterDelete.status).toBe(201);
    expect((await counters(org.organisationId)).TASKS).toBe(0);
  });

  it('leaves an unrelated org\'s counters untouched', async () => {
    const victim = await signupOrg('cascade-bystander');
    const vAuth = { Authorization: `Bearer ${victim.token}` };
    const vProject = await createProject(vAuth, 'Keep me');
    await createIssue(vAuth, vProject, 'keep');

    const other = await signupOrg('cascade-actor');
    const oAuth = { Authorization: `Bearer ${other.token}` };
    const oProject = await createProject(oAuth, 'Delete me');
    await createIssue(oAuth, oProject, 'go');
    expect((await request(app).delete(`/api/projects/${oProject}`).set(oAuth)).status).toBe(204);

    const bystander = await counters(victim.organisationId);
    expect(bystander.PROJECTS).toBe(1);
    expect(bystander.TASKS).toBe(1);
  });
});
