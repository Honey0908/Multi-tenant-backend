import { withOrgContext } from '../lib/db.js';
import { getTenantContext } from '../lib/requestContext.js';
import { assertProjectAccess } from '../lib/projectAccess.js';
import { Prisma } from '../generated/prisma/client.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../lib/errors.js';
import { paginate, toSkipTake, type PaginationInput } from '../lib/pagination.js';
import type { AddProjectMemberInput } from '../validators/projectMember.js';

// Never select password_hash: a membership row is returned to every member.
const memberSelect = {
  id: true,
  project_id: true,
  user_id: true,
  created_at: true,
  user: { select: { id: true, email: true, first_name: true, last_name: true, role: true, status: true } },
} satisfies Prisma.ProjectMemberSelect;

/** Admin-only (enforced at the route). Adds an org user to a project. */
export async function addProjectMember(projectId: string, input: AddProjectMemberInput) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    await assertProjectAccess(tx, projectId);

    // RLS hides other tenants' users, so a cross-tenant id looks identical to
    // a nonexistent one: 404 either way.
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) {
      throw new NotFoundError(`User ${input.userId} not found`);
    }
    if (user.status !== 'ACTIVE') {
      throw new UnprocessableError('Inactive users cannot be added to a project');
    }

    try {
      return await tx.projectMember.create({
        data: { organisation_id: orgId, project_id: projectId, user_id: input.userId },
        select: memberSelect,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('User is already a member of this project');
      }
      throw error;
    }
  });
}

/** Anyone who can see the project can see who else is on it. */
export async function listProjectMembers(projectId: string, pagination: PaginationInput) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    await assertProjectAccess(tx, projectId);
    const where = { project_id: projectId };
    const members = await tx.projectMember.findMany({
      where,
      select: memberSelect,
      orderBy: { created_at: 'asc' },
      ...toSkipTake(pagination),
    });
    const total = await tx.projectMember.count({ where });
    return paginate(members, total, pagination);
  });
}

/**
 * Admin-only. Removes the membership, then unassigns that user's issues in
 * the project — in one transaction, so there is never a moment where someone
 * is assigned work in a project they can no longer see. The delete runs
 * first: it takes a row lock that waits for any in-flight assignment
 * (assertAssignable holds `FOR SHARE` on this row) to commit, so the
 * unassign below sees and clears it.
 */
export async function removeProjectMember(projectId: string, userId: string) {
  const { orgId } = getTenantContext();

  await withOrgContext(orgId, async (tx) => {
    await assertProjectAccess(tx, projectId);

    const { count } = await tx.projectMember.deleteMany({ where: { project_id: projectId, user_id: userId } });
    if (count === 0) {
      throw new NotFoundError(`User ${userId} is not a member of this project`);
    }

    await tx.issue.updateMany({
      where: { project_id: projectId, assignee_id: userId },
      data: { assignee_id: null },
    });
  });
}
