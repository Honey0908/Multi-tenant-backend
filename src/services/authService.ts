import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { withOrgContext } from '../lib/db.js';
import { getTenantContext } from '../lib/requestContext.js';
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

/**
 * Resolves the caller from their token back to live database state.
 *
 * A JWT is a snapshot: it keeps asserting the role and account it was
 * minted with until it expires, even if the user has since been
 * deactivated, demoted, or removed. So this re-reads the row on every call
 * rather than trusting the claims, and rejects a token whose user no longer
 * exists or is no longer ACTIVE. The SPA calls this on boot to restore a
 * session, which is also why it must not simply echo the token back: the
 * frontend should never decode a JWT to decide what a user may do.
 */
export async function getCurrentUser() {
  const { orgId, userId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    // RLS confines this to the caller's own organisation, so a token whose
    // orgId and userId disagree resolves to nothing.
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedError('Account no longer exists');
    }
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedError('Account is not active');
    }

    const organisation = await tx.organisation.findUniqueOrThrow({
      where: { id: orgId },
      include: { plan: true },
    });

    return { user: omitPasswordHash(user), organisation };
  });
}
