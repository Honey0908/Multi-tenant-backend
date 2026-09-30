import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, signupOrg, promoteToPlatformAdmin, uniqueSlug } from './helpers.js';
import { getTenantClient, withOrgContext } from '../lib/db.js';

// "Organisation" used to be the one tenant table without RLS: a query that
// forgot to filter by the caller's org returned every tenant on the
// platform. These lock in that the database itself now prevents it, rather
// than every service remembering to add `where: { id: orgId }`.
describe('Organisation tenant isolation', () => {
  it('returns only the caller\'s own org to a deliberately careless unfiltered query', async () => {
    const mine = await signupOrg('careless-mine');
    const theirs = await signupOrg('careless-theirs');

    // This is the careless query the architecture has to survive: no
    // `where` clause at all, the kind a future feature could easily add.
    const rows = await getTenantClient(mine.organisationId).organisation.findMany();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(mine.organisationId);
    expect(rows.map((r) => r.id)).not.toContain(theirs.organisationId);
  });

  it('hides another tenant\'s org from a direct lookup by its real id', async () => {
    const mine = await signupOrg('direct-mine');
    const theirs = await signupOrg('direct-theirs');

    const row = await getTenantClient(mine.organisationId).organisation.findUnique({
      where: { id: theirs.organisationId },
    });

    expect(row).toBeNull();
  });

  it('refuses to let the application role rewrite the shared plan catalog', async () => {
    const org = await signupOrg('plan-catalog');

    // Raising max_projects platform-wide would void plan enforcement for
    // every tenant on that tier, so `app_user` holds no write grant at all.
    await expect(
      withOrgContext(org.organisationId, (tx) =>
        tx.$executeRaw`UPDATE "SubscriptionPlan" SET max_projects = 9999`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('still lets a tenant read its own org and the plan it is on', async () => {
    const org = await signupOrg('own-org');
    const row = await getTenantClient(org.organisationId).organisation.findUnique({
      where: { id: org.organisationId },
      include: { plan: true },
    });

    expect(row?.id).toBe(org.organisationId);
    expect(row?.plan.name).toBe('Starter');
  });

  it('still reports a duplicate slug as 409, now from the unique index', async () => {
    const slug = uniqueSlug('dupe');
    const body = {
      organisationName: 'First',
      organisationSlug: slug,
      email: `${uniqueSlug('dupe-a')}@example.test`,
      password: 'password123',
      firstName: 'A',
      lastName: 'B',
    };

    expect((await request(app).post('/api/auth/signup').send(body)).status).toBe(201);

    const second = await request(app)
      .post('/api/auth/signup')
      .send({ ...body, email: `${uniqueSlug('dupe-b')}@example.test` });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CONFLICT');
    expect(second.body.message).toMatch(/already taken/i);
  });

  it('still lets a platform admin read org metadata across tenants', async () => {
    const target = await signupOrg('rls-pa-target');
    const admin = await signupOrg('rls-pa-admin');
    const adminAuth = { Authorization: `Bearer ${await promoteToPlatformAdmin(admin)}` };

    // platform_reader reads through its own SELECT-only policy, with no
    // app.org_id set — the regression this guards is RLS locking admins out.
    const res = await request(app).get(`/api/organisations/${target.organisationId}`).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(target.organisationId);
    expect(res.body.plan.name).toBe('Starter');
  });

  it('does not let one tenant read another tenant\'s org over the API', async () => {
    const a = await signupOrg('api-a');
    const b = await signupOrg('api-b');

    // Org routes are platform-admin only, so an ordinary tenant is stopped
    // at authorization before RLS is even reached — defence in depth.
    const res = await request(app)
      .get(`/api/organisations/${a.organisationId}`)
      .set({ Authorization: `Bearer ${b.token}` });
    expect(res.status).toBe(403);
  });
});
