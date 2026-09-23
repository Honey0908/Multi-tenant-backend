import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../app.js';

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

export { app };
