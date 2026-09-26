import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, signupOrg } from './helpers.js';

describe('concurrency-safe plan limits', () => {
  it('lets exactly one of two simultaneous requests through when only one slot is left', async () => {
    const org = await signupOrg('concurrency-projects');
    const auth = { Authorization: `Bearer ${org.token}` };

    // Starter plan: max_projects = 3. Bring the org to limit - 1 (2 of 3)
    // sequentially first, so the race is specifically over the last slot.
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/api/projects').set(auth).send({ name: `Warmup ${i}` });
      expect(res.status).toBe(201);
    }

    // Two requests for the 3rd (and only remaining) slot, fired together.
    // claimUsage's single conditional UPDATE takes a row lock on the org's
    // UsageCounter row, so Postgres serializes these two transactions on
    // that row — whichever commits first leaves `value` at max_limit, and
    // the second's `value + 1 <= max_limit` check then fails. There is no
    // window where both can read a stale "2 of 3" and both proceed.
    const [first, second] = await Promise.all([
      request(app).post('/api/projects').set(auth).send({ name: 'Racer A' }),
      request(app).post('/api/projects').set(auth).send({ name: 'Racer B' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const list = await request(app).get('/api/projects').set(auth);
    expect(list.body).toHaveLength(3);
  });

  it('lets exactly one of ten simultaneous requests through at the limit', async () => {
    const org = await signupOrg('concurrency-projects-10');
    const auth = { Authorization: `Bearer ${org.token}` };

    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/api/projects').set(auth).send({ name: `Warmup ${i}` });
      expect(res.status).toBe(201);
    }

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app).post('/api/projects').set(auth).send({ name: `Racer ${i}` }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(9);

    const list = await request(app).get('/api/projects').set(auth);
    expect(list.body).toHaveLength(3);
  });
});
