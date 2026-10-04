import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, signupOrg, uniqueSlug } from './helpers.js';

type Org = Awaited<ReturnType<typeof signupOrg>>;

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Admin creates an ORG_MEMBER user and returns their id plus a login token. */
async function createMember(admin: Org) {
  const email = `${uniqueSlug('member')}@example.test`;
  const create = await request(app)
    .post('/api/users')
    .set(bearer(admin.token))
    .send({ email, password: 'password123', firstName: 'Mem', lastName: 'Ber', role: 'ORG_MEMBER' });
  expect(create.status).toBe(201);

  const login = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
  expect(login.status).toBe(200);
  return { id: create.body.id as string, token: login.body.token as string };
}

async function createProject(admin: Org, name = 'Project') {
  const res = await request(app).post('/api/projects').set(bearer(admin.token)).send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addToProject(admin: Org, projectId: string, userId: string) {
  return request(app).post(`/api/projects/${projectId}/members`).set(bearer(admin.token)).send({ userId });
}

async function createIssue(token: string, projectId: string, body: object = {}) {
  return request(app)
    .post(`/api/projects/${projectId}/issues`)
    .set(bearer(token))
    .send({ title: 'Task', ...body });
}

describe('project visibility', () => {
  it('shows a member only the projects they belong to, and the admin everything', async () => {
    const admin = await signupOrg('pm-visibility');
    const member = await createMember(admin);
    const mine = await createProject(admin, 'Mine');
    const other = await createProject(admin, 'Not mine');
    expect((await addToProject(admin, mine, member.id)).status).toBe(201);

    const memberList = await request(app).get('/api/projects').set(bearer(member.token));
    expect(memberList.status).toBe(200);
    expect(memberList.body.items.map((p: { id: string }) => p.id)).toEqual([mine]);
    expect(memberList.body.pagination.total).toBe(1);

    const adminList = await request(app).get('/api/projects').set(bearer(admin.token));
    expect(adminList.body.items.map((p: { id: string }) => p.id).sort()).toEqual([mine, other].sort());

    expect((await request(app).get(`/api/projects/${mine}`).set(bearer(member.token))).status).toBe(200);
    // 404, not 403: a non-member must not be able to tell the project exists.
    expect((await request(app).get(`/api/projects/${other}`).set(bearer(member.token))).status).toBe(404);
  });

  it('hides a project\'s issues, members and attachments from a non-member with 404', async () => {
    const admin = await signupOrg('pm-hidden');
    const outsider = await createMember(admin);
    const projectId = await createProject(admin);
    const issue = await createIssue(admin.token, projectId);
    expect(issue.status).toBe(201);
    const base = `/api/projects/${projectId}/issues`;
    const auth = bearer(outsider.token);

    expect((await request(app).get(base).set(auth)).status).toBe(404);
    expect((await request(app).get(`${base}/${issue.body.id}`).set(auth)).status).toBe(404);
    expect((await createIssue(outsider.token, projectId)).status).toBe(404);
    expect((await request(app).patch(`${base}/${issue.body.id}`).set(auth).send({ title: 'x' })).status).toBe(404);
    expect((await request(app).delete(`${base}/${issue.body.id}`).set(auth)).status).toBe(404);
    expect((await request(app).get(`/api/projects/${projectId}/members`).set(auth)).status).toBe(404);

    const attachments = `${base}/${issue.body.id}/attachments`;
    const reserve = await request(app)
      .post(`${attachments}/reserve`)
      .set(auth)
      .send({ fileName: 'a.txt', contentType: 'text/plain', sizeBytes: 10 });
    expect(reserve.status).toBe(404);

    // Same response as a project that does not exist at all.
    const ghost = await request(app).get(`/api/projects/00000000-0000-4000-8000-000000000000/issues`).set(auth);
    expect(ghost.status).toBe(404);
  });

  it('lets a member work on issues in their project but not manage projects', async () => {
    const admin = await signupOrg('pm-writes');
    const member = await createMember(admin);
    const projectId = await createProject(admin);
    await addToProject(admin, projectId, member.id);
    const auth = bearer(member.token);

    const issue = await createIssue(member.token, projectId);
    expect(issue.status).toBe(201);
    const patch = await request(app)
      .patch(`/api/projects/${projectId}/issues/${issue.body.id}`)
      .set(auth)
      .send({ status: 'DONE' });
    expect(patch.status).toBe(200);

    // Project writes are admin-only, whether or not the caller is a member.
    expect((await request(app).post('/api/projects').set(auth).send({ name: 'Nope' })).status).toBe(403);
    expect((await request(app).patch(`/api/projects/${projectId}`).set(auth).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).delete(`/api/projects/${projectId}`).set(auth)).status).toBe(403);
  });
});

describe('project members API', () => {
  it('adds, lists and removes members; only admins may add or remove', async () => {
    const admin = await signupOrg('pm-crud');
    const member = await createMember(admin);
    const projectId = await createProject(admin);

    const add = await addToProject(admin, projectId, member.id);
    expect(add.status).toBe(201);
    expect(add.body.user_id).toBe(member.id);
    expect(add.body.user.password_hash).toBeUndefined();

    expect((await addToProject(admin, projectId, member.id)).status).toBe(409);

    // A member can read the roster but not change it.
    const list = await request(app).get(`/api/projects/${projectId}/members`).set(bearer(member.token));
    expect(list.status).toBe(200);
    expect(list.body.items.map((m: { user_id: string }) => m.user_id)).toEqual([member.id]);
    expect(list.body.pagination.total).toBe(1);
    expect((await addToProject({ ...admin, token: member.token }, projectId, admin.userId)).status).toBe(403);
    const memberRemoves = await request(app)
      .delete(`/api/projects/${projectId}/members/${member.id}`)
      .set(bearer(member.token));
    expect(memberRemoves.status).toBe(403);

    const remove = await request(app)
      .delete(`/api/projects/${projectId}/members/${member.id}`)
      .set(bearer(admin.token));
    expect(remove.status).toBe(204);
    expect((await request(app).get(`/api/projects/${projectId}`).set(bearer(member.token))).status).toBe(404);

    const removeAgain = await request(app)
      .delete(`/api/projects/${projectId}/members/${member.id}`)
      .set(bearer(admin.token));
    expect(removeAgain.status).toBe(404);
  });

  it('rejects a user from another organisation, and an inactive user', async () => {
    const admin = await signupOrg('pm-cross-a');
    const otherOrg = await signupOrg('pm-cross-b');
    const projectId = await createProject(admin);

    // The other tenant's user is invisible under RLS: indistinguishable from nonexistent.
    expect((await addToProject(admin, projectId, otherOrg.userId)).status).toBe(404);

    const member = await createMember(admin);
    const deactivate = await request(app)
      .patch(`/api/users/${member.id}`)
      .set(bearer(admin.token))
      .send({ status: 'INACTIVE' });
    expect(deactivate.status).toBe(200);
    expect((await addToProject(admin, projectId, member.id)).status).toBe(422);
  });

  it('cannot reach another tenant\'s project through the members routes', async () => {
    const a = await signupOrg('pm-tenant-a');
    const b = await signupOrg('pm-tenant-b');
    const projectId = await createProject(a);

    expect((await request(app).get(`/api/projects/${projectId}/members`).set(bearer(b.token))).status).toBe(404);
    expect((await addToProject(b, projectId, b.userId)).status).toBe(404);
  });
});

describe('task assignment', () => {
  it('assigns only project members, and unassigns with null', async () => {
    const admin = await signupOrg('pm-assign');
    const member = await createMember(admin);
    const outsider = await createMember(admin);
    const projectId = await createProject(admin);
    await addToProject(admin, projectId, member.id);

    const created = await createIssue(admin.token, projectId, { assignee_id: member.id });
    expect(created.status).toBe(201);
    expect(created.body.assignee_id).toBe(member.id);

    const rejectedOnCreate = await createIssue(admin.token, projectId, { assignee_id: outsider.id });
    expect(rejectedOnCreate.status).toBe(422);

    const url = `/api/projects/${projectId}/issues/${created.body.id}`;
    const rejected = await request(app).patch(url).set(bearer(admin.token)).send({ assignee_id: outsider.id });
    expect(rejected.status).toBe(422);

    const cleared = await request(app).patch(url).set(bearer(admin.token)).send({ assignee_id: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.assignee_id).toBeNull();

    // Omitting assignee_id on a later patch leaves it alone.
    await request(app).patch(url).set(bearer(admin.token)).send({ assignee_id: member.id });
    const renamed = await request(app).patch(url).set(bearer(admin.token)).send({ title: 'Renamed' });
    expect(renamed.body.assignee_id).toBe(member.id);
  });

  it('rejects an assignee from another organisation', async () => {
    const admin = await signupOrg('pm-assign-a');
    const otherOrg = await signupOrg('pm-assign-b');
    const projectId = await createProject(admin);

    const res = await createIssue(admin.token, projectId, { assignee_id: otherOrg.userId });
    expect(res.status).toBe(422);
  });

  it('clears a user\'s assignments when they are removed from the project', async () => {
    const admin = await signupOrg('pm-unassign');
    const member = await createMember(admin);
    const projectId = await createProject(admin);
    const otherProject = await createProject(admin, 'Other');
    await addToProject(admin, projectId, member.id);
    await addToProject(admin, otherProject, member.id);

    const here = await createIssue(admin.token, projectId, { assignee_id: member.id });
    const elsewhere = await createIssue(admin.token, otherProject, { assignee_id: member.id });

    await request(app).delete(`/api/projects/${projectId}/members/${member.id}`).set(bearer(admin.token));

    const after = await request(app)
      .get(`/api/projects/${projectId}/issues/${here.body.id}`)
      .set(bearer(admin.token));
    expect(after.body.assignee_id).toBeNull();

    // Only that project's assignments are cleared.
    const untouched = await request(app)
      .get(`/api/projects/${otherProject}/issues/${elsewhere.body.id}`)
      .set(bearer(admin.token));
    expect(untouched.body.assignee_id).toBe(member.id);
  });

  it('clears assignments when a user is deactivated, and when they are deleted', async () => {
    const admin = await signupOrg('pm-deactivate');
    const toDeactivate = await createMember(admin);
    const toDelete = await createMember(admin);
    const projectId = await createProject(admin);
    await addToProject(admin, projectId, toDeactivate.id);
    await addToProject(admin, projectId, toDelete.id);

    const first = await createIssue(admin.token, projectId, { assignee_id: toDeactivate.id });
    const second = await createIssue(admin.token, projectId, { assignee_id: toDelete.id });

    const deactivate = await request(app)
      .patch(`/api/users/${toDeactivate.id}`)
      .set(bearer(admin.token))
      .send({ status: 'INACTIVE' });
    expect(deactivate.status).toBe(200);
    // A deleted user's FK has no ON DELETE SET NULL, so this would 500 if unassign were skipped.
    const del = await request(app).delete(`/api/users/${toDelete.id}`).set(bearer(admin.token));
    expect(del.status).toBe(204);

    for (const issue of [first, second]) {
      const res = await request(app)
        .get(`/api/projects/${projectId}/issues/${issue.body.id}`)
        .set(bearer(admin.token));
      expect(res.body.assignee_id).toBeNull();
    }

    // An inactive user can't be assigned even though they're still a member.
    const reassign = await request(app)
      .patch(`/api/projects/${projectId}/issues/${first.body.id}`)
      .set(bearer(admin.token))
      .send({ assignee_id: toDeactivate.id });
    expect(reassign.status).toBe(422);
  });

  it('never leaves a non-member assigned when an assignment races a removal', async () => {
    const admin = await signupOrg('pm-race');
    const member = await createMember(admin);
    const projectId = await createProject(admin);
    await addToProject(admin, projectId, member.id);
    const issue = await createIssue(admin.token, projectId);
    const url = `/api/projects/${projectId}/issues/${issue.body.id}`;

    await Promise.all([
      request(app).patch(url).set(bearer(admin.token)).send({ assignee_id: member.id }),
      request(app).delete(`/api/projects/${projectId}/members/${member.id}`).set(bearer(admin.token)),
    ]);

    // Either order is fine, but the member is gone, so the assignment must be too.
    const after = await request(app).get(url).set(bearer(admin.token));
    expect(after.body.assignee_id).toBeNull();
  });
});
