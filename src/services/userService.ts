import argon2 from 'argon2';
import { withOrgContext, withPlatformOrgContext } from '../lib/db.js';
import { getTenantContext } from '../lib/requestContext.js';
import { claimUsage } from '../lib/usageCounters.js';
import { ResourceType } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { omitPasswordHash } from '../lib/serialize.js';
import type { CreateUserInput } from '../validators/user.js';

/** Adds a member to the *caller's own* organisation (orgId comes from their JWT, never the request body). */
export async function createUser(input: CreateUserInput) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    const organisation = await tx.organisation.findUniqueOrThrow({
      where: { id: orgId },
      include: { plan: true },
    });

    await claimUsage(tx, orgId, ResourceType.USERS, organisation.plan.name);

    const passwordHash = await argon2.hash(input.password);

    try {
      const user = await tx.user.create({
        data: {
          organisation_id: orgId,
          email: input.email,
          password_hash: passwordHash,
          first_name: input.firstName,
          last_name: input.lastName,
          role: input.role,
        },
      });
      return omitPasswordHash(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(`Email "${input.email}" is already registered`);
      }
      throw error;
    }
  });
}

/** Platform-admin only: lists one organisation's members over the read-only platform_reader connection. */
export async function listOrganisationUsers(organisationId: string) {
  return withPlatformOrgContext(organisationId, async (tx) => {
    const organisation = await tx.organisation.findUnique({ where: { id: organisationId } });
    if (!organisation) {
      throw new NotFoundError(`Organisation ${organisationId} not found`);
    }

    const users = await tx.user.findMany({
      where: { organisation_id: organisationId },
      orderBy: { created_at: 'asc' },
    });
    return users.map(omitPasswordHash);
  });
}
