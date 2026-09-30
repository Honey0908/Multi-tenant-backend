import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { withOrgContext } from '../lib/db.js';
import { authPrisma } from '../lib/authPrisma.js';
import { signAccessToken } from '../lib/jwt.js';
import { Prisma } from '../generated/prisma/client.js';
import { ConflictError, UnauthorizedError } from '../lib/errors.js';
import { omitPasswordHash } from '../lib/serialize.js';
import { initUsageCounters } from '../lib/usageCounters.js';
import type { SignupInput } from '../validators/auth.js';
import type { LoginInput } from '../validators/auth.js';

const DEFAULT_PLAN_NAME = 'Starter';

export async function signup(input: SignupInput) {
  const orgId = randomUUID();

  return withOrgContext(orgId, async (tx) => {
    const defaultPlan = await tx.subscriptionPlan.findUnique({ where: { name: DEFAULT_PLAN_NAME } });
    if (!defaultPlan) {
      throw new Error(`Default plan "${DEFAULT_PLAN_NAME}" is not seeded — run \`npm run db:seed\``);
    }

    // The slug collision is detected from the unique index rather than a
    // prior findUnique. Two reasons: RLS on "Organisation" now hides other
    // tenants' rows, so a pre-check could not see the row it was looking
    // for anyway; and the index is race-free where a check-then-create is
    // not — two simultaneous signups claiming one slug used to both pass
    // the check. `slug` is the only unique constraint on Organisation, so a
    // P2002 here can mean nothing else.
    let organisation;
    try {
      organisation = await tx.organisation.create({
        data: {
          id: orgId,
          name: input.organisationName,
          slug: input.organisationSlug,
          plan_id: defaultPlan.id,
        },
        include: { plan: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(`Organisation slug "${input.organisationSlug}" is already taken`);
      }
      throw error;
    }

    const passwordHash = await argon2.hash(input.password);

    let user;
    try {
      user = await tx.user.create({
        data: {
          organisation_id: orgId,
          email: input.email,
          password_hash: passwordHash,
          first_name: input.firstName,
          last_name: input.lastName,
          role: 'ORG_ADMIN',
        },
      });
    } catch (error) {
      // `email` is the only unique constraint on User.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(`Email "${input.email}" is already registered`);
      }
      throw error;
    }

    // The first ORG_ADMIN created here already occupies one seat.
    await initUsageCounters(tx, orgId, defaultPlan, 1);

    const token = signAccessToken({ userId: user.id, orgId, role: user.role });

    return { token, organisation, user: omitPasswordHash(user) };
  });
}

export async function login(input: LoginInput) {
  const user = await authPrisma.user.findUnique({ where: { email: input.email } });
  if (!user) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const passwordValid = await argon2.verify(user.password_hash, input.password);
  if (!passwordValid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  if (user.status !== 'ACTIVE') {
    throw new UnauthorizedError('Account is not active');
  }

  const token = signAccessToken({ userId: user.id, orgId: user.organisation_id, role: user.role });

  return { token, user: omitPasswordHash(user) };
}
