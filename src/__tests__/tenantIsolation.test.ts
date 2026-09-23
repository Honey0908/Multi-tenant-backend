import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, signupOrg } from './helpers.js';

describe('tenant isolation', () => {
  it('rejects requests with no bearer token', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
  });

  it("does not let Org B see or modify Org A's project, even when both use the same name", async () => {
    const orgA = await signupOrg('tenant-a');
    const orgB = await signupOrg('tenant-b');

    const createA = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${orgA.token}`)
      .send({ name: 'Shared Name Project' });
    expect(createA.status).toBe(201);
    const projectAId = createA.body.id;

    // Org B creates a project with the identical name — proves isolation
    // isn't accidentally keyed on name collisions.
    const createB = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${orgB.token}`)
      .send({ name: 'Shared Name Project' });
    expect(createB.status).toBe(201);
    expect(createB.body.id).not.toBe(projectAId);

    const listB = await request(app).get('/api/projects').set('Authorization', `Bearer ${orgB.token}`);
    expect(listB.status).toBe(200);
    expect(listB.body).toHaveLength(1);
    expect(listB.body[0].id).not.toBe(projectAId);

    const getB = await request(app)
      .get(`/api/projects/${projectAId}`)
      .set('Authorization', `Bearer ${orgB.token}`);
    expect(getB.status).toBe(404);

    const patchB = await request(app)
      .patch(`/api/projects/${projectAId}`)
      .set('Authorization', `Bearer ${orgB.token}`)
      .send({ name: 'Hijacked' });
    expect(patchB.status).toBe(404);

    const deleteB = await request(app)
      .delete(`/api/projects/${projectAId}`)
      .set('Authorization', `Bearer ${orgB.token}`);
    expect(deleteB.status).toBe(404);

    // Org A's project must be untouched by Org B's attempts.
    const getA = await request(app)
      .get(`/api/projects/${projectAId}`)
      .set('Authorization', `Bearer ${orgA.token}`);
    expect(getA.status).toBe(200);
    expect(getA.body.name).toBe('Shared Name Project');
  });

  it("does not let Org B see or modify an issue inside Org A's project", async () => {
    const orgA = await signupOrg('tenant-issue-a');
    const orgB = await signupOrg('tenant-issue-b');

    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${orgA.token}`)
      .send({ name: 'Org A Project' });
    const projectId = project.body.id;

    const issue = await request(app)
      .post(`/api/projects/${projectId}/issues`)
      .set('Authorization', `Bearer ${orgA.token}`)
      .send({ title: 'Org A Issue' });
    expect(issue.status).toBe(201);
    const issueId = issue.body.id;

    // Org B doesn't even see the project, so nested issue routes 404.
    const listB = await request(app)
      .get(`/api/projects/${projectId}/issues`)
      .set('Authorization', `Bearer ${orgB.token}`);
    expect(listB.status).toBe(404);

    const getB = await request(app)
      .get(`/api/projects/${projectId}/issues/${issueId}`)
      .set('Authorization', `Bearer ${orgB.token}`);
    expect(getB.status).toBe(404);

    const patchB = await request(app)
      .patch(`/api/projects/${projectId}/issues/${issueId}`)
      .set('Authorization', `Bearer ${orgB.token}`)
      .send({ status: 'DONE' });
    expect(patchB.status).toBe(404);

    const getA = await request(app)
      .get(`/api/projects/${projectId}/issues/${issueId}`)
      .set('Authorization', `Bearer ${orgA.token}`);
    expect(getA.status).toBe(200);
    expect(getA.body.status).toBe('TODO');
  });
});
