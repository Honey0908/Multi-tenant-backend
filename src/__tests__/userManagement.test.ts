import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, signupOrg, uniqueSlug } from './helpers.js';

async function addMember(auth: Record<string, string>, role: 'ORG_ADMIN' | 'ORG_MEMBER' = 'ORG_MEMBER') {
  const email = `${uniqueSlug('member')}@example.test`;
  const res = await request(app)
    .post('/api/users')
    .set(auth)
    .send({ email, password: 'password123', firstName: 'New', lastName: 'Member', role });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, email };
}

async function tokenFor(email: string) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.token}` };
}

describe('organisation user management', () => {
  it('lists only the caller\'s own organisation members', async () => {
    const mine = await signupOrg('um-mine');
    const theirs = await signupOrg('um-theirs');
    const auth = { Authorization: `Bearer ${mine.token}` };
    await addMember(auth);

    const res = await request(app).get('/api/users').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.items.map((u: { id: string }) => u.id)).not.toContain(theirs.userId);
    expect(res.body.items[0].password_hash).toBeUndefined();
  });

  it('lets an admin change a member\'s role and status', async () => {
    const org = await signupOrg('um-patch');
    const auth = { Authorization: `Bearer ${org.token}` };
    const member = await addMember(auth);

    const promoted = await request(app).patch(`/api/users/${member.id}`).set(auth).send({ role: 'ORG_ADMIN' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe('ORG_ADMIN');

    const deactivated = await request(app).patch(`/api/users/${member.id}`).set(auth).send({ status: 'INACTIVE' });
    expect(deactivated.status).toBe(200);

    // A deactivated account can no longer authenticate.
    const login = await request(app).post('/api/auth/login').send({ email: member.email, password: 'password123' });
    expect(login.status).toBe(401);
  });

  it('frees the seat again when a member is removed', async () => {
    const org = await signupOrg('um-seat');
    const auth = { Authorization: `Bearer ${org.token}` };

    // Starter allows 5 seats; the founding admin already holds one.
    const members = [];
    for (let i = 0; i < 4; i += 1) {
      members.push(await addMember(auth));
    }

    const atLimit = await request(app)
      .post('/api/users')
      .set(auth)
      .send({ email: `${uniqueSlug('over')}@example.test`, password: 'password123', firstName: 'A', lastName: 'B' });
    expect(atLimit.status).toBe(409);

    expect((await request(app).delete(`/api/users/${members[0]!.id}`).set(auth)).status).toBe(204);

    const afterRemoval = await request(app)
      .post('/api/users')
      .set(auth)
      .send({ email: `${uniqueSlug('reuse')}@example.test`, password: 'password123', firstName: 'A', lastName: 'B' });
    expect(afterRemoval.status).toBe(201);
  });

  it('refuses to strand an organisation without an active admin', async () => {
    const org = await signupOrg('um-lastadmin');
    const auth = { Authorization: `Bearer ${org.token}` };
    await addMember(auth, 'ORG_MEMBER');

    const demote = await request(app).patch(`/api/users/${org.userId}`).set(auth).send({ role: 'ORG_MEMBER' });
    expect(demote.status).toBe(409);
    expect(demote.body.message).toMatch(/last active administrator/i);

    const deactivate = await request(app).patch(`/api/users/${org.userId}`).set(auth).send({ status: 'INACTIVE' });
    expect(deactivate.status).toBe(409);
  });

  it('refuses self-deletion', async () => {
    const org = await signupOrg('um-self');
    const auth = { Authorization: `Bearer ${org.token}` };
    const res = await request(app).delete(`/api/users/${org.userId}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/your own account/i);
  });

  it('never assigns PLATFORM_ADMIN through the update endpoint', async () => {
    const org = await signupOrg('um-escalate');
    const auth = { Authorization: `Bearer ${org.token}` };
    const member = await addMember(auth);

    const res = await request(app).patch(`/api/users/${member.id}`).set(auth).send({ role: 'PLATFORM_ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('stops an ordinary member from managing users', async () => {
    const org = await signupOrg('um-member');
    const adminAuth = { Authorization: `Bearer ${org.token}` };
    const member = await addMember(adminAuth);
    const memberAuth = await tokenFor(member.email);

    // Readable — members need the directory to pick assignees.
    expect((await request(app).get('/api/users').set(memberAuth)).status).toBe(200);
    // Not writable.
    expect((await request(app).patch(`/api/users/${member.id}`).set(memberAuth).send({ firstName: 'X' })).status).toBe(403);
    expect((await request(app).delete(`/api/users/${member.id}`).set(memberAuth)).status).toBe(403);
  });

  // Mandatory Test 3 from the spec: cross-tenant user management.
  it('denies an admin any access to another organisation\'s user', async () => {
    const a = await signupOrg('um-cross-a');
    const b = await signupOrg('um-cross-b');
    const aAuth = { Authorization: `Bearer ${a.token}` };

    expect((await request(app).get(`/api/users/${b.userId}`).set(aAuth)).status).toBe(404);
    expect((await request(app).patch(`/api/users/${b.userId}`).set(aAuth).send({ firstName: 'Hacked' })).status).toBe(404);
    expect((await request(app).delete(`/api/users/${b.userId}`).set(aAuth)).status).toBe(404);

    // And Org B's own admin is untouched.
    const stillThere = await request(app).get(`/api/users/${b.userId}`).set({ Authorization: `Bearer ${b.token}` });
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.first_name).not.toBe('Hacked');
  });
});
