import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, signupOrg, uniqueSlug } from './helpers.js';
import { withOrgContext } from '../lib/db.js';

describe('GET /api/auth/me', () => {
  it('resolves the caller to live database state', async () => {
    const org = await signupOrg('me-ok');
    const res = await request(app).get('/api/auth/me').set({ Authorization: `Bearer ${org.token}` });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(org.userId);
    expect(res.body.user.role).toBe('ORG_ADMIN');
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.body.organisation.id).toBe(org.organisationId);
    expect(res.body.organisation.plan.name).toBe('Starter');
  });

  it('rejects a still-valid token whose account has been deactivated', async () => {
    const org = await signupOrg('me-revoked');
    const auth = { Authorization: `Bearer ${org.token}` };
    expect((await request(app).get('/api/auth/me').set(auth)).status).toBe(200);

    // The token stays cryptographically valid — only the database changes.
    await withOrgContext(org.organisationId, (tx) =>
      tx.user.update({ where: { id: org.userId }, data: { status: 'INACTIVE' } }),
    );

    const res = await request(app).get('/api/auth/me').set(auth);
    expect(res.status).toBe(401);
  });

  it('requires a token', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  it('accepts a logout from an authenticated caller', async () => {
    const org = await signupOrg('me-logout');
    const res = await request(app).post('/api/auth/logout').set({ Authorization: `Bearer ${org.token}` });
    expect(res.status).toBe(204);
  });
});

describe('own organisation and usage', () => {
  it('returns the caller\'s own organisation with no id in the path', async () => {
    const org = await signupOrg('own-org-route');
    const res = await request(app).get('/api/organisation').set({ Authorization: `Bearer ${org.token}` });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(org.organisationId);
    expect(res.body.plan.name).toBe('Starter');
  });

  it('reports usage that tracks the counters enforcement actually reads', async () => {
    const org = await signupOrg('usage');
    const auth = { Authorization: `Bearer ${org.token}` };

    const before = await request(app).get('/api/organisation/usage').set(auth);
    expect(before.status).toBe(200);
    expect(before.body.plan.maxProjects).toBe(3);
    expect(before.body.usage.projects).toEqual({ used: 0, limit: 3, remaining: 3 });
    // The founding admin already occupies a seat.
    expect(before.body.usage.users).toEqual({ used: 1, limit: 5, remaining: 4 });
    expect(before.body.usage.storageBytes.limit).toBe(1024 * 1024 * 1024);

    await request(app).post('/api/projects').set(auth).send({ name: 'One' });

    const after = await request(app).get('/api/organisation/usage').set(auth);
    expect(after.body.usage.projects).toEqual({ used: 1, limit: 3, remaining: 2 });
  });

  it('never exposes another tenant\'s usage', async () => {
    const a = await signupOrg('usage-a');
    const b = await signupOrg('usage-b');
    await request(app).post('/api/projects').set({ Authorization: `Bearer ${a.token}` }).send({ name: 'A only' });

    const res = await request(app).get('/api/organisation/usage').set({ Authorization: `Bearer ${b.token}` });
    expect(res.body.organisation.id).toBe(b.organisationId);
    expect(res.body.usage.projects.used).toBe(0);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/organisation')).status).toBe(401);
    expect((await request(app).get('/api/organisation/usage')).status).toBe(401);
  });
});

describe('pagination', () => {
  it('pages through a list and reports totals', async () => {
    const org = await signupOrg('paging');
    const auth = { Authorization: `Bearer ${org.token}` };
    const projectId = (await request(app).post('/api/projects').set(auth).send({ name: 'P' })).body.id;

    for (let i = 0; i < 5; i += 1) {
      await request(app).post(`/api/projects/${projectId}/issues`).set(auth).send({ title: `task ${i}` });
    }

    const first = await request(app).get(`/api/projects/${projectId}/issues?page=1&limit=2`).set(auth);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });

    const last = await request(app).get(`/api/projects/${projectId}/issues?page=3&limit=2`).set(auth);
    expect(last.body.items).toHaveLength(1);

    // Pages must not overlap.
    const firstIds = first.body.items.map((i: { id: string }) => i.id);
    expect(firstIds).not.toContain(last.body.items[0].id);
  });

  it('defaults sensibly and rejects invalid or oversized page requests', async () => {
    const org = await signupOrg('paging-guard');
    const auth = { Authorization: `Bearer ${org.token}` };

    const defaults = await request(app).get('/api/projects').set(auth);
    expect(defaults.body.pagination.page).toBe(1);
    expect(defaults.body.pagination.limit).toBe(20);

    // An unbounded limit would let one request pull a whole table into memory.
    expect((await request(app).get('/api/projects?limit=5000').set(auth)).status).toBe(400);
    expect((await request(app).get('/api/projects?page=0').set(auth)).status).toBe(400);
    expect((await request(app).get('/api/projects?page=abc').set(auth)).status).toBe(400);
  });
});

describe('CORS', () => {
  it('allows the configured frontend origin to read responses', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('answers the preflight a cross-origin JSON + Authorization request triggers', async () => {
    const res = await request(app)
      .options('/api/projects')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });

  it('does not hand an unlisted origin permission to read responses', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// The frontend repo is separate, so it generates its API client from this
// endpoint rather than vendoring a copy of the YAML that could go stale.
describe('OpenAPI document endpoint', () => {
  it('serves the spec as JSON for client generation', async () => {
    const res = await request(app).get('/openapi.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info.title).toBe('TaskFlow API');
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(0);
  });

  it('answers /docs/openapi.json with JSON, not the Swagger UI page', async () => {
    // swagger-ui-express renders its HTML for any unmatched /docs/* path, so
    // a generator pointed here would otherwise receive 200 text/html.
    const res = await request(app).get('/docs/openapi.json');

    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.info.title).toBe('TaskFlow API');
  });

  it('is not cached, so a regenerated client always sees the current contract', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('exposes every operation with an operationId', async () => {
    const res = await request(app).get('/openapi.json');
    const ops = Object.values(res.body.paths).flatMap((item) => Object.values(item as object));
    expect(ops.length).toBe(29);
    expect(ops.every((op: { operationId?: string }) => Boolean(op.operationId))).toBe(true);
  });
});
