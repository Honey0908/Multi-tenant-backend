import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, signupOrg, setStorageLimit, expireReservation } from './helpers.js';
import { ensureBucketExists, headObject } from '../lib/s3.js';

async function createIssue(auth: Record<string, string>) {
  const project = await request(app).post('/api/projects').set(auth).send({ name: 'Attachment Project' });
  const issue = await request(app)
    .post(`/api/projects/${project.body.id}/issues`)
    .set(auth)
    .send({ title: 'Attachment Issue' });
  return { projectId: project.body.id as string, issueId: issue.body.id as string };
}

function attachmentsUrl(projectId: string, issueId: string, suffix = '') {
  return `/api/projects/${projectId}/issues/${issueId}/attachments${suffix}`;
}

async function reserveAndUpload(
  auth: Record<string, string>,
  projectId: string,
  issueId: string,
  body: number[] | Buffer,
  overrides: Partial<{ fileName: string; contentType: string; sizeBytes: number }> = {},
) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const reserveRes = await request(app)
    .post(attachmentsUrl(projectId, issueId, '/reserve'))
    .set(auth)
    .send({
      fileName: overrides.fileName ?? 'notes.txt',
      contentType: overrides.contentType ?? 'text/plain',
      sizeBytes: overrides.sizeBytes ?? bytes.length,
    });
  if (reserveRes.status !== 201) {
    return { reserveRes, uploadOk: false };
  }

  const uploadResponse = await fetch(reserveRes.body.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': overrides.contentType ?? 'text/plain' },
    body: bytes,
  });
  return { reserveRes, uploadOk: uploadResponse.ok };
}

describe('attachments (SeaweedFS reserve/commit/storage limits)', () => {
  beforeAll(async () => {
    await ensureBucketExists();
  });

  it('reserves, uploads, and commits an attachment end-to-end', async () => {
    const org = await signupOrg('attach-happy');
    const auth = { Authorization: `Bearer ${org.token}` };
    const { projectId, issueId } = await createIssue(auth);

    const { reserveRes, uploadOk } = await reserveAndUpload(auth, projectId, issueId, Buffer.from('hello world'));
    expect(reserveRes.status).toBe(201);
    expect(reserveRes.body.attachment.status).toBe('RESERVED');
    expect(uploadOk).toBe(true);

    const attachmentId = reserveRes.body.attachment.id as string;
    const commitRes = await request(app).post(attachmentsUrl(projectId, issueId, `/${attachmentId}/commit`)).set(auth);
    expect(commitRes.status).toBe(200);
    expect(commitRes.body.status).toBe('COMMITTED');
    expect(commitRes.body.size_bytes).toBe(Buffer.from('hello world').length);

    const getRes = await request(app).get(attachmentsUrl(projectId, issueId, `/${attachmentId}`)).set(auth);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(attachmentId);

    const listRes = await request(app).get(attachmentsUrl(projectId, issueId)).set(auth);
    expect(listRes.status).toBe(200);
    expect(listRes.body.map((a: { id: string }) => a.id)).toContain(attachmentId);
  });

  it('rejects commit before any bytes have been uploaded to the reserved location', async () => {
    const org = await signupOrg('attach-no-upload');
    const auth = { Authorization: `Bearer ${org.token}` };
    const { projectId, issueId } = await createIssue(auth);

    const reserveRes = await request(app)
      .post(attachmentsUrl(projectId, issueId, '/reserve'))
      .set(auth)
      .send({ fileName: 'ghost.txt', contentType: 'text/plain', sizeBytes: 5 });
    expect(reserveRes.status).toBe(201);

    const commitRes = await request(app)
      .post(attachmentsUrl(projectId, issueId, `/${reserveRes.body.attachment.id}/commit`))
      .set(auth);
    expect(commitRes.status).toBe(409);
  });

  it('rejects a disallowed content type and a path-traversal file name before touching storage', async () => {
    const org = await signupOrg('attach-validation');
    const auth = { Authorization: `Bearer ${org.token}` };
    const { projectId, issueId } = await createIssue(auth);

    const badType = await request(app)
      .post(attachmentsUrl(projectId, issueId, '/reserve'))
      .set(auth)
      .send({ fileName: 'script.exe', contentType: 'application/x-msdownload', sizeBytes: 10 });
    expect(badType.status).toBe(400);

    const badName = await request(app)
      .post(attachmentsUrl(projectId, issueId, '/reserve'))
      .set(auth)
      .send({ fileName: '../../etc/passwd', contentType: 'text/plain', sizeBytes: 10 });
    expect(badName.status).toBe(400);
  });

  it('rejects a reservation over the hard per-file size cap', async () => {
    const org = await signupOrg('attach-oversize');
    const auth = { Authorization: `Bearer ${org.token}` };
    const { projectId, issueId } = await createIssue(auth);

    const res = await request(app)
      .post(attachmentsUrl(projectId, issueId, '/reserve'))
      .set(auth)
      .send({ fileName: 'huge.bin', contentType: 'application/zip', sizeBytes: 500 * 1024 * 1024 });
    expect(res.status).toBe(413);
  });

  it('enforces the plan storage limit on reserve and frees it again on delete', async () => {
    const org = await signupOrg('attach-storage-limit');
    const auth = { Authorization: `Bearer ${org.token}` };
    const { projectId, issueId } = await createIssue(auth);
    await setStorageLimit(org.organisationId, 100);

    const within = await reserveAndUpload(auth, projectId, issueId, Buffer.alloc(60, 'a'));
    expect(within.reserveRes.status).toBe(201);
    const attachmentId = within.reserveRes.body.attachment.id as string;
    await request(app).post(attachmentsUrl(projectId, issueId, `/${attachmentId}/commit`)).set(auth);

    const overLimit = await request(app)
      .post(attachmentsUrl(projectId, issueId, '/reserve'))
      .set(auth)
      .send({ fileName: 'too-big.txt', contentType: 'text/plain', sizeBytes: 50 });
    expect(overLimit.status).toBe(409);
    expect(overLimit.body.message).toMatch(/storage bytes/i);

    const del = await request(app).delete(attachmentsUrl(projectId, issueId, `/${attachmentId}`)).set(auth);
    expect(del.status).toBe(204);

    const fitsNow = await request(app)
      .post(attachmentsUrl(projectId, issueId, '/reserve'))
      .set(auth)
      .send({ fileName: 'fits-now.txt', contentType: 'text/plain', sizeBytes: 50 });
    expect(fitsNow.status).toBe(201);

    const object = await headObject(within.reserveRes.body.attachment.storage_key);
    expect(object).toBeNull();
  });

  it('lets exactly one of two simultaneous reservations through when only one slot is left', async () => {
    const org = await signupOrg('attach-concurrency');
    const auth = { Authorization: `Bearer ${org.token}` };
    const { projectId, issueId } = await createIssue(auth);
    await setStorageLimit(org.organisationId, 100);

    const [first, second] = await Promise.all([
      request(app).post(attachmentsUrl(projectId, issueId, '/reserve')).set(auth).send({
        fileName: 'racer-a.txt',
        contentType: 'text/plain',
        sizeBytes: 100,
      }),
      request(app).post(attachmentsUrl(projectId, issueId, '/reserve')).set(auth).send({
        fileName: 'racer-b.txt',
        contentType: 'text/plain',
        sizeBytes: 100,
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('releases an abandoned reservation once its TTL has lapsed, on the next reserve', async () => {
    const org = await signupOrg('attach-expiry');
    const auth = { Authorization: `Bearer ${org.token}` };
    const { projectId, issueId } = await createIssue(auth);
    await setStorageLimit(org.organisationId, 100);

    const abandoned = await request(app)
      .post(attachmentsUrl(projectId, issueId, '/reserve'))
      .set(auth)
      .send({ fileName: 'abandoned.txt', contentType: 'text/plain', sizeBytes: 100 });
    expect(abandoned.status).toBe(201);

    const blockedWhileHeld = await request(app)
      .post(attachmentsUrl(projectId, issueId, '/reserve'))
      .set(auth)
      .send({ fileName: 'blocked.txt', contentType: 'text/plain', sizeBytes: 50 });
    expect(blockedWhileHeld.status).toBe(409);

    await expireReservation(org.organisationId, abandoned.body.attachment.id);

    const afterSweep = await request(app)
      .post(attachmentsUrl(projectId, issueId, '/reserve'))
      .set(auth)
      .send({ fileName: 'after-sweep.txt', contentType: 'text/plain', sizeBytes: 50 });
    expect(afterSweep.status).toBe(201);
  });

  it("prevents one org from reading, committing, or deleting another org's attachment", async () => {
    const orgA = await signupOrg('attach-tenant-a');
    const orgB = await signupOrg('attach-tenant-b');
    const authA = { Authorization: `Bearer ${orgA.token}` };
    const authB = { Authorization: `Bearer ${orgB.token}` };
    const { projectId, issueId } = await createIssue(authA);

    const { reserveRes } = await reserveAndUpload(authA, projectId, issueId, Buffer.from('org a secret'));
    const attachmentId = reserveRes.body.attachment.id as string;
    await request(app).post(attachmentsUrl(projectId, issueId, `/${attachmentId}/commit`)).set(authA);

    const getAsB = await request(app).get(attachmentsUrl(projectId, issueId, `/${attachmentId}`)).set(authB);
    expect(getAsB.status).toBe(404);

    const commitAsB = await request(app)
      .post(attachmentsUrl(projectId, issueId, `/${attachmentId}/commit`))
      .set(authB);
    expect(commitAsB.status).toBe(404);

    const deleteAsB = await request(app).delete(attachmentsUrl(projectId, issueId, `/${attachmentId}`)).set(authB);
    expect(deleteAsB.status).toBe(404);

    const stillThereForA = await request(app)
      .get(attachmentsUrl(projectId, issueId, `/${attachmentId}`))
      .set(authA);
    expect(stillThereForA.status).toBe(200);
  });
});
