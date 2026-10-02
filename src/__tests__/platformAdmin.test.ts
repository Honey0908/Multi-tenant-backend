import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, signupOrg, promoteToPlatformAdmin } from './helpers.js';

describe('platform admin routes', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/organisations/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated ORG_ADMIN (wrong role) with 403', async () => {
    const org = await signupOrg('platform-forbidden');
    const auth = { Authorization: `Bearer ${org.token}` };

    const getOrg = await request(app).get(`/api/organisations/${org.organisationId}`).set(auth);
    expect(getOrg.status).toBe(403);

    const listUsers = await request(app).get(`/api/organisations/${org.organisationId}/users`).set(auth);
    expect(listUsers.status).toBe(403);

    const createOrg = await request(app).post('/api/organisations').set(auth).send({ name: 'x', slug: 'x-y-z' });
    expect(createOrg.status).toBe(403);
  });

  it('lets a PLATFORM_ADMIN read organisation metadata and its member list', async () => {
    const target = await signupOrg('platform-target');
    const admin = await signupOrg('platform-admin-org');
    const adminAuth = { Authorization: `Bearer ${await promoteToPlatformAdmin(admin)}` };

    const getOrg = await request(app).get(`/api/organisations/${target.organisationId}`).set(adminAuth);
    expect(getOrg.status).toBe(200);
    expect(getOrg.body.id).toBe(target.organisationId);

    const listUsers = await request(app).get(`/api/organisations/${target.organisationId}/users`).set(adminAuth);
    expect(listUsers.status).toBe(200);
    expect(listUsers.body.items).toHaveLength(1);
    expect(listUsers.body.items[0].id).toBe(target.userId);
    expect(listUsers.body.items[0].password_hash).toBeUndefined();
  });

  it('rejects an unauthenticated request to list organisations', async () => {
    const res = await request(app).get('/api/organisations');
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated ORG_ADMIN (wrong role) listing organisations', async () => {
    const org = await signupOrg('platform-list-forbidden');
    const res = await request(app)
      .get('/api/organisations')
      .set({ Authorization: `Bearer ${org.token}` });
    expect(res.status).toBe(403);
  });

  it('lets a PLATFORM_ADMIN page through every organisation with plan and aggregate usage', async () => {
    const target = await signupOrg('platform-list-target');
    const admin = await signupOrg('platform-list-admin');
    const adminAuth = { Authorization: `Bearer ${await promoteToPlatformAdmin(admin)}` };

    // The dev DB this suite runs against is long-lived (not reset per test
    // run), so the target org is not guaranteed to land on page 1 — page
    // through with the max page size until it turns up or pages run out.
    let found: { id: string; plan?: { name?: string }; usage?: { users?: unknown } } | undefined;
    let page = 1;
    for (;;) {
      const res = await request(app)
        .get('/api/organisations')
        .query({ page, limit: 100 })
        .set(adminAuth);
      expect(res.status).toBe(200);
      found = res.body.items.find((item: { id: string }) => item.id === target.organisationId);
      if (found || page >= res.body.pagination.totalPages) break;
      page += 1;
    }

    expect(found).toBeDefined();
    expect(found!.plan?.name).toBe('Starter');
    expect(found!.usage?.users).toEqual({ used: 1, limit: expect.any(Number), remaining: expect.any(Number) });
  });

  it('lets a PLATFORM_ADMIN provision a bare organisation', async () => {
    const admin = await signupOrg('platform-admin-provision');
    const adminAuth = { Authorization: `Bearer ${await promoteToPlatformAdmin(admin)}` };

    const res = await request(app)
      .post('/api/organisations')
      .set(adminAuth)
      .send({ name: 'Provisioned Org', slug: `provisioned-${admin.slug}` });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe(`provisioned-${admin.slug}`);
  });
});
