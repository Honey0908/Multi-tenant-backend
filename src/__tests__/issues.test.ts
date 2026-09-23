import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, signupOrg } from './helpers.js';

describe('issues CRUD', () => {
  let auth: { Authorization: string };
  let projectId: string;

  beforeAll(async () => {
    const org = await signupOrg('issue-crud');
    auth = { Authorization: `Bearer ${org.token}` };
    const project = await request(app).post('/api/projects').set(auth).send({ name: 'Issue Project' });
    projectId = project.body.id;
  });

  it('404s when the parent project does not exist', async () => {
    const fakeProjectId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app).post(`/api/projects/${fakeProjectId}/issues`).set(auth).send({ title: 'x' });
    expect(res.status).toBe(404);
  });

  it('supports create, get, list, patch, delete', async () => {
    const create = await request(app)
      .post(`/api/projects/${projectId}/issues`)
      .set(auth)
      .send({ title: 'Fix bug', priority: 'HIGH' });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('TODO');
    const id = create.body.id;

    const get = await request(app).get(`/api/projects/${projectId}/issues/${id}`).set(auth);
    expect(get.status).toBe(200);
    expect(get.body.priority).toBe('HIGH');

    const list = await request(app).get(`/api/projects/${projectId}/issues`).set(auth);
    expect(list.status).toBe(200);
    expect(list.body.map((i: { id: string }) => i.id)).toContain(id);

    const patch = await request(app)
      .patch(`/api/projects/${projectId}/issues/${id}`)
      .set(auth)
      .send({ status: 'DONE' });
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe('DONE');

    const del = await request(app).delete(`/api/projects/${projectId}/issues/${id}`).set(auth);
    expect(del.status).toBe(204);

    const getAfterDelete = await request(app).get(`/api/projects/${projectId}/issues/${id}`).set(auth);
    expect(getAfterDelete.status).toBe(404);
  });

  it("404s for an issue id that belongs to a different project in the same org", async () => {
    const otherProject = await request(app).post('/api/projects').set(auth).send({ name: 'Other Project' });
    const otherProjectId = otherProject.body.id;
    const issueInOther = await request(app)
      .post(`/api/projects/${otherProjectId}/issues`)
      .set(auth)
      .send({ title: 'Belongs elsewhere' });

    const res = await request(app)
      .get(`/api/projects/${projectId}/issues/${issueInOther.body.id}`)
      .set(auth);
    expect(res.status).toBe(404);
  });
});
