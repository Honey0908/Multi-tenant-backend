import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../app.js';
import { withOrgContext } from '../lib/db.js';

export function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

interface SignedUpOrg {
  token: string;
  organisationId: string;
  userId: string;
  slug: string;
  email: string;
}

export async function signupOrg(prefix = 'org'): Promise<SignedUpOrg> {
  const slug = uniqueSlug(prefix);
  const email = `${slug}@example.test`;

  const res = await request(app).post('/api/auth/signup').send({
    organisationName: `Org ${slug}`,
    organisationSlug: slug,
    email,
    password: 'password123',
    firstName: 'Test',
    lastName: 'Admin',
  });

  if (res.status !== 201) {
    throw new Error(`signup helper failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    token: res.body.token,
    organisationId: res.body.organisation.id,
    userId: res.body.user.id,
    slug,
    email,
  };
}

/**
 * Elevates an existing user to PLATFORM_ADMIN directly via the DB (there is
 * no API path that can do this, by design — see validators/user.ts and
 * validators/auth.ts) and returns a fresh token carrying the new role, so
 * platform-admin route tests don't depend on the seeded bootstrap account
 * or its env-overridable credentials.
 */
export async function promoteToPlatformAdmin(org: SignedUpOrg): Promise<string> {
  await withOrgContext(org.organisationId, (tx) =>
    tx.user.update({ where: { id: org.userId }, data: { role: 'PLATFORM_ADMIN' } }),
  );

  const res = await request(app).post('/api/auth/login').send({ email: org.email, password: 'password123' });
  if (res.status !== 200) {
    throw new Error(`promoteToPlatformAdmin login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

/**
 * Directly overrides an org's STORAGE_BYTES UsageCounter limit — there is no
 * API path to do this (plan limits come from the assigned SubscriptionPlan),
 * and the Starter plan's real 1GB limit is too large to exercise in a test
 * without uploading huge files. Mirrors promoteToPlatformAdmin's approach of
 * reaching into the DB directly for test setup that the API doesn't expose.
 */
export async function setStorageLimit(organisationId: string, maxBytes: number): Promise<void> {
  await withOrgContext(organisationId, (tx) =>
    tx.usageCounter.update({
      where: { organisation_id_resource_type: { organisation_id: organisationId, resource_type: 'STORAGE_BYTES' } },
      data: { max_limit: BigInt(maxBytes) },
    }),
  );
}

/** Forces a RESERVED attachment's reservation to already be expired, for testing the expiry sweep. */
export async function expireReservation(organisationId: string, attachmentId: string): Promise<void> {
  await withOrgContext(organisationId, (tx) =>
    tx.attachment.update({
      where: { id: attachmentId },
      data: { expires_at: new Date(Date.now() - 60_000) },
    }),
  );
}

export { app };
