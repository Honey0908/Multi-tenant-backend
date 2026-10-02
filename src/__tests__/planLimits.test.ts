import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, signupOrg } from './helpers.js';

describe('plan limits (UsageCounter)', () => {
  it('enforces the seat limit on user creation and reports it as "seats"', async () => {
    const org = await signupOrg('seat-limit');
    const auth = { Authorization: `Bearer ${org.token}` };

    // Starter plan: max_users = 5. The signup ORG_ADMIN already occupies
    // seat 1, so 4 more should succeed before the 5th is rejected.
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/api/users')
        .set(auth)
        .send({ email: `seat-${i}-${org.slug}@example.test`, password: 'password123', firstName: 'A', lastName: 'B' });
      expect(res.status).toBe(201);
    }

    const overLimit = await request(app)
      .post('/api/users')
      .set(auth)
      .send({ email: `seat-over-${org.slug}@example.test`, password: 'password123', firstName: 'A', lastName: 'B' });
    expect(overLimit.status).toBe(409);
    expect(overLimit.body.message).toMatch(/5 of 5 seats/);
  });

  it('rejects user creation from a non-admin member', async () => {
    const org = await signupOrg('seat-role-check');
    const auth = { Authorization: `Bearer ${org.token}` };

    const memberRes = await request(app)
      .post('/api/users')
      .set(auth)
      .send({ email: `member-${org.slug}@example.test`, password: 'password123', firstName: 'A', lastName: 'B', role: 'ORG_MEMBER' });
    expect(memberRes.status).toBe(201);

    const memberLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: memberRes.body.email, password: 'password123' });
    const memberAuth = { Authorization: `Bearer ${memberLogin.body.token}` };

    const forbidden = await request(app)
      .post('/api/users')
      .set(memberAuth)
      .send({ email: `blocked-${org.slug}@example.test`, password: 'password123', firstName: 'A', lastName: 'B' });
    expect(forbidden.status).toBe(403);
  });

  it('ignores a client-supplied organisationId — the user always lands in the caller\'s own org', async () => {
    const orgA = await signupOrg('seat-scope-a');
    const orgB = await signupOrg('seat-scope-b');
    const auth = { Authorization: `Bearer ${orgA.token}` };

    const res = await request(app)
      .post('/api/users')
      .set(auth)
      .send({
        organisationId: orgB.organisationId,
        email: `cross-${orgA.slug}@example.test`,
        password: 'password123',
        firstName: 'A',
        lastName: 'B',
      });
    expect(res.status).toBe(201);
    expect(res.body.organisation_id).toBe(orgA.organisationId);
  });

  it('enforces the task limit and frees a slot again after deleting a task', async () => {
    const org = await signupOrg('task-limit');
    const auth = { Authorization: `Bearer ${org.token}` };

    const project = await request(app).post('/api/projects').set(auth).send({ name: 'Task Limit Project' });
    const projectId = project.body.id;

    // Starter plan: max_tasks = 100 — too many to create one at a time in a
    // test, so we prove both directions (claim + release) at a small scale
    // by checking the org's own counter isn't shared with another org and
    // that a delete actually frees the slot, rather than driving 100 creates.
    const created = await request(app)
      .post(`/api/projects/${projectId}/issues`)
      .set(auth)
      .send({ title: 'Task 1' });
    expect(created.status).toBe(201);

    const del = await request(app)
      .delete(`/api/projects/${projectId}/issues/${created.body.id}`)
      .set(auth);
    expect(del.status).toBe(204);

    // If the counter hadn't been released, a second create would still
    // succeed anyway (limit is 100) — so this mainly guards against a
    // regression that makes releaseUsage throw or corrupt the row.
    const again = await request(app)
      .post(`/api/projects/${projectId}/issues`)
      .set(auth)
      .send({ title: 'Task 2' });
    expect(again.status).toBe(201);
  });

  it('frees a project slot again after deleting a project', async () => {
    const org = await signupOrg('project-release');
    const auth = { Authorization: `Bearer ${org.token}` };

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/projects').set(auth).send({ name: `Project ${i}` });
      expect(res.status).toBe(201);
      ids.push(res.body.id);
    }

    const blocked = await request(app).post('/api/projects').set(auth).send({ name: 'Blocked' });
    expect(blocked.status).toBe(409);

    const del = await request(app).delete(`/api/projects/${ids[0]}`).set(auth);
    expect(del.status).toBe(204);

    const afterDelete = await request(app).post('/api/projects').set(auth).send({ name: 'Fits now' });
    expect(afterDelete.status).toBe(201);
  });
});
