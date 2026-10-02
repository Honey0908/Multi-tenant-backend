import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import { uniqueSlug } from './helpers.js';

describe('POST /api/auth/signup', () => {
  it('creates an organisation, an ORG_ADMIN user, and returns a token', async () => {
    const slug = uniqueSlug('signup');
    const res = await request(app).post('/api/auth/signup').send({
      organisationName: `Org ${slug}`,
      organisationSlug: slug,
      email: `${slug}@example.test`,
      password: 'password123',
      firstName: 'Ada',
      lastName: 'Admin',
    });

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.organisation.slug).toBe(slug);
    expect(res.body.user.role).toBe('ORG_ADMIN');
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('rejects a request with an invalid body before touching the database', async () => {
    const res = await request(app).post('/api/auth/signup').send({ organisationName: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rolls back the whole transaction when the user insert fails mid-transaction, leaving zero orphaned rows', async () => {
    const first = await request(app).post('/api/auth/signup').send({
      organisationName: 'Existing Org',
      organisationSlug: uniqueSlug('rollback-a'),
      email: `${uniqueSlug('rollback-email')}@example.test`,
      password: 'password123',
      firstName: 'First',
      lastName: 'User',
    });
    expect(first.status).toBe(201);

    // Second signup reuses the same email (globally unique on User) but a
    // brand-new org slug — the User insert fails on P2002, and if the
    // transaction actually rolled back, this slug was never persisted.
    const newSlug = uniqueSlug('rollback-b');
    const conflicting = await request(app).post('/api/auth/signup').send({
      organisationName: 'Orphan Org',
      organisationSlug: newSlug,
      email: first.body.user.email,
      password: 'password123',
      firstName: 'Second',
      lastName: 'User',
    });
    expect(conflicting.status).toBe(409);

    // If the org row had leaked out of the rolled-back transaction, this
    // retry would 409 on the slug instead of succeeding.
    const retry = await request(app).post('/api/auth/signup').send({
      organisationName: 'Orphan Org Retry',
      organisationSlug: newSlug,
      email: `${uniqueSlug('rollback-retry')}@example.test`,
      password: 'password123',
      firstName: 'Retry',
      lastName: 'User',
    });
    expect(retry.status).toBe(201);
    expect(retry.body.organisation.slug).toBe(newSlug);
  });
});

describe('POST /api/auth/login', () => {
  it('issues a token for correct credentials', async () => {
    const slug = uniqueSlug('login');
    const email = `${slug}@example.test`;
    await request(app).post('/api/auth/signup').send({
      organisationName: `Org ${slug}`,
      organisationSlug: slug,
      email,
      password: 'password123',
      firstName: 'Log',
      lastName: 'In',
    });

    const res = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.email).toBe(email);
  });

  it('rejects an incorrect password', async () => {
    const slug = uniqueSlug('login-bad');
    const email = `${slug}@example.test`;
    await request(app).post('/api/auth/signup').send({
      organisationName: `Org ${slug}`,
      organisationSlug: slug,
      email,
      password: 'password123',
      firstName: 'Log',
      lastName: 'In',
    });

    const res = await request(app).post('/api/auth/login').send({ email, password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.test', password: 'password123' });
    expect(res.status).toBe(401);
  });
});
