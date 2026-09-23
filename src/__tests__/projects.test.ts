import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, signupOrg } from './helpers.js';

describe('projects CRUD', () => {
  it('supports create, get, list, patch, delete', async () => {
    const org = await signupOrg('proj-crud');
    const auth = { Authorization: `Bearer ${org.token}` };

    const create = await request(app).post('/api/projects').set(auth).send({ name: 'Alpha', description: 'first' });
    expect(create.status).toBe(201);
    const id = create.body.id;

    const get = await request(app).get(`/api/projects/${id}`).set(auth);
    expect(get.status).toBe(200);
    expect(get.body.name).toBe('Alpha');

    const list = await request(app).get('/api/projects').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.map((p: { id: string }) => p.id)).toContain(id);

    const patch = await request(app).patch(`/api/projects/${id}`).set(auth).send({ status: 'ARCHIVED' });
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe('ARCHIVED');

    const del = await request(app).delete(`/api/projects/${id}`).set(auth);
    expect(del.status).toBe(204);

    const getAfterDelete = await request(app).get(`/api/projects/${id}`).set(auth);
    expect(getAfterDelete.status).toBe(404);
  });

  it('rejects an empty patch body', async () => {
    const org = await signupOrg('proj-empty-patch');
    const auth = { Authorization: `Bearer ${org.token}` };
    const create = await request(app).post('/api/projects').set(auth).send({ name: 'Beta' });

    const patch = await request(app).patch(`/api/projects/${create.body.id}`).set(auth).send({});
    expect(patch.status).toBe(400);
  });

  it('enforces the plan project limit (Starter = 3) and returns 409 on the 4th', async () => {
    const org = await signupOrg('proj-limit');
    const auth = { Authorization: `Bearer ${org.token}` };

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/projects').set(auth).send({ name: `Project ${i}` });
      expect(res.status).toBe(201);
    }

    const overLimit = await request(app).post('/api/projects').set(auth).send({ name: 'Project 4' });
    expect(overLimit.status).toBe(409);
    expect(overLimit.body.message).toMatch(/3 of 3/);

    // A second, unrelated org must not be affected by the first org's quota.
    const otherOrg = await signupOrg('proj-limit-other');
    const otherAuth = { Authorization: `Bearer ${otherOrg.token}` };
    const otherRes = await request(app).post('/api/projects').set(otherAuth).send({ name: 'Fresh org project' });
    expect(otherRes.status).toBe(201);
  });
});
