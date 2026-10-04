import argon2 from 'argon2';
import { withOrgContext, withPlatformOrgContext } from '../lib/db.js';
import { getTenantContext } from '../lib/requestContext.js';
import { claimUsage, releaseUsage } from '../lib/usageCounters.js';
import { paginate, toSkipTake, type PaginationInput } from '../lib/pagination.js';
import { ResourceType } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { omitPasswordHash } from '../lib/serialize.js';
import type { CreateUserInput, UpdateUserInput } from '../validators/user.js';

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
export async function listOrganisationUsers(organisationId: string, pagination: PaginationInput) {
  return withPlatformOrgContext(organisationId, async (tx) => {
    const organisation = await tx.organisation.findUnique({ where: { id: organisationId } });
    if (!organisation) {
      throw new NotFoundError(`Organisation ${organisationId} not found`);
    }

    const where = { organisation_id: organisationId };
    const users = await tx.user.findMany({
      where,
      orderBy: { created_at: 'asc' },
      ...toSkipTake(pagination),
    });
    const total = await tx.user.count({ where });

    return paginate(users.map(omitPasswordHash), total, pagination);
  });
}

/**
 * Refuses a change that would leave the organisation with no active
 * ORG_ADMIN. Without this an admin can lock every human out of a tenant in
 * one request — by demoting, deactivating, or deleting the last one — and
 * no self-service path exists to recover, because fixing it needs an admin.
 */
async function assertNotLastAdmin(
  tx: Prisma.TransactionClient,
  orgId: string,
  excludingUserId: string,
): Promise<void> {
  const remaining = await tx.user.count({
    where: {
      organisation_id: orgId,
      role: 'ORG_ADMIN',
      status: 'ACTIVE',
      id: { not: excludingUserId },
    },
  });
  if (remaining === 0) {
    throw new ConflictError(
      'This is the last active administrator — promote another member before changing this one',
    );
  }
}

/**
 * The caller's own organisation directory, paginated.
 *
 * Readable by any authenticated member, not just admins: members need it to
 * pick an assignee or see who a task belongs to. Managing those users stays
 * admin-only (see the route). RLS scopes the rows either way.
 */
export async function listUsers(pagination: PaginationInput) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    const where = { organisation_id: orgId };
    // Sequential, not Promise.all: both statements share one connection
    // inside the transaction, so issuing them concurrently buys nothing.
    const users = await tx.user.findMany({
      where,
      orderBy: { created_at: 'asc' },
      ...toSkipTake(pagination),
    });
    const total = await tx.user.count({ where });

    return paginate(users.map(omitPasswordHash), total, pagination);
  });
}

/** One member of the caller's own organisation. */
export async function getUser(id: string) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    const user = await tx.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundError(`User ${id} not found`);
    }
    return omitPasswordHash(user);
  });
}

/** Updates a member's name, role, or status. Cross-tenant targets are invisible to RLS, so they 404. */
export async function updateUser(id: string, input: UpdateUserInput) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    const target = await tx.user.findUnique({ where: { id } });
    if (!target) {
      throw new NotFoundError(`User ${id} not found`);
    }

    const losesAdmin =
      (input.role !== undefined && input.role !== 'ORG_ADMIN') || input.status === 'INACTIVE';
    if (target.role === 'ORG_ADMIN' && target.status === 'ACTIVE' && losesAdmin) {
      await assertNotLastAdmin(tx, orgId, id);
    }

    const updated = await tx.user.update({
      where: { id },
      data: {
        ...(input.firstName !== undefined ? { first_name: input.firstName } : {}),
        ...(input.lastName !== undefined ? { last_name: input.lastName } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });

    // An inactive user can't act on anything, so work assigned to them would
    // sit stranded. Cleared after the update above: that UPDATE takes a row
    // lock on the user which waits out any in-flight assignment (it holds
    // FOR SHARE — see issueService.assertAssignable), so none can slip past.
    // Memberships are kept, so reactivating restores their project access.
    if (input.status === 'INACTIVE') {
      await tx.issue.updateMany({ where: { assignee_id: id }, data: { assignee_id: null } });
    }
    return omitPasswordHash(updated);
  });
}

/** Removes a member and frees the seat their account was holding. */
export async function deleteUser(id: string) {
  const { orgId, userId } = getTenantContext();

  if (id === userId) {
    throw new ConflictError('You cannot remove your own account');
  }

  await withOrgContext(orgId, async (tx) => {
    const target = await tx.user.findUnique({ where: { id } });
    if (!target) {
      throw new NotFoundError(`User ${id} not found`);
    }
    if (target.role === 'ORG_ADMIN' && target.status === 'ACTIVE') {
      await assertNotLastAdmin(tx, orgId, id);
    }

    // Issue.assignee has no ON DELETE SET NULL (see schema.prisma), so the
    // assignments must go first or the delete fails on the foreign key.
    // Project memberships cascade on their own.
    await tx.issue.updateMany({ where: { assignee_id: id }, data: { assignee_id: null } });
    await tx.user.delete({ where: { id } });
    // Seats were claimed on creation but, until this endpoint existed,
    // could never be given back — an org permanently lost headroom for
    // every member it removed out of band.
    await releaseUsage(tx, orgId, ResourceType.USERS);
  });
}
