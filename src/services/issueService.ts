import type { Prisma } from '../generated/prisma/client.js';
import { withOrgContext } from '../lib/db.js';
import { assertProjectAccess } from '../lib/projectAccess.js';
import { purgeAttachmentsOfIssue } from '../lib/cascade.js';
import { deleteObject } from '../lib/s3.js';
import { getTenantContext } from '../lib/requestContext.js';
import { claimUsage, releaseUsage } from '../lib/usageCounters.js';
import { ResourceType } from '../generated/prisma/enums.js';
import { NotFoundError, UnprocessableError } from '../lib/errors.js';
import { paginate, toSkipTake, type PaginationInput } from '../lib/pagination.js';
import type { CreateIssueInput, UpdateIssueInput } from '../validators/issue.js';

/**
 * An assignee must be an active member of the issue's project. Checked in
 * the same transaction as the write, with the membership and user rows
 * locked `FOR SHARE`: removeProjectMember / updateUser delete or update those
 * rows and then clear assignments, so without the lock an assignment racing a
 * removal could commit after the clean-up and leave a non-member assigned.
 * A user from another tenant is invisible to RLS here, so they simply have no
 * membership row and are rejected the same way.
 */
async function assertAssignable(tx: Prisma.TransactionClient, projectId: string, assigneeId: string) {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT u.status::text AS status
    FROM "ProjectMember" pm
    JOIN "User" u ON u.organisation_id = pm.organisation_id AND u.id = pm.user_id
    WHERE pm.project_id = ${projectId}::uuid AND pm.user_id = ${assigneeId}::uuid
    FOR SHARE OF pm, u
  `;
  if (rows.length === 0) {
    throw new UnprocessableError('Assignee must be a member of this project');
  }
  if (rows[0].status !== 'ACTIVE') {
    throw new UnprocessableError('Assignee must be an active user');
  }
}

export async function createIssue(projectId: string, input: CreateIssueInput) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    await assertProjectAccess(tx, projectId);
    if (input.assignee_id) {
      await assertAssignable(tx, projectId, input.assignee_id);
    }

    const organisation = await tx.organisation.findUniqueOrThrow({
      where: { id: orgId },
      include: { plan: true },
    });

    await claimUsage(tx, orgId, ResourceType.TASKS, organisation.plan.name);

    return tx.issue.create({
      data: {
        organisation_id: orgId,
        project_id: projectId,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        assignee_id: input.assignee_id ?? null,
      },
    });
  });
}

export async function listIssues(projectId: string, pagination: PaginationInput) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    await assertProjectAccess(tx, projectId);
    const where = { project_id: projectId };
    const issues = await tx.issue.findMany({
      where,
      orderBy: { created_at: 'asc' },
      ...toSkipTake(pagination),
    });
    const total = await tx.issue.count({ where });
    return paginate(issues, total, pagination);
  });
}

/**
 * Every issue route — and every attachment route, which resolves its issue
 * through here — passes the project-membership check, so a non-member gets
 * the same 404 whether the project, the issue, or neither exists.
 */
export async function getIssue(projectId: string, id: string) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    await assertProjectAccess(tx, projectId);
    const issue = await tx.issue.findFirst({ where: { id, project_id: projectId } });
    if (!issue) {
      throw new NotFoundError(`Issue ${id} not found`);
    }
    return issue;
  });
}

export async function updateIssue(projectId: string, id: string, input: UpdateIssueInput) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    await assertProjectAccess(tx, projectId);
    if (input.assignee_id) {
      await assertAssignable(tx, projectId, input.assignee_id);
    }

    const { count } = await tx.issue.updateMany({ where: { id, project_id: projectId }, data: input });
    if (count === 0) {
      throw new NotFoundError(`Issue ${id} not found`);
    }
    return tx.issue.findUniqueOrThrow({ where: { id } });
  });
}

export async function deleteIssue(projectId: string, id: string) {
  const { orgId } = getTenantContext();

  // Attachments go first so their storage quota is settled from real row
  // counts rather than vanishing silently down the FK cascade (see
  // lib/cascade.ts). An issue id that belongs to a different project fails
  // the delete below and rolls the attachment purge back with it.
  const orphanedKeys = await withOrgContext(orgId, async (tx) => {
    await assertProjectAccess(tx, projectId);
    const storageKeys = await purgeAttachmentsOfIssue(tx, orgId, id);

    const { count } = await tx.issue.deleteMany({ where: { id, project_id: projectId, organisation_id: orgId } });
    if (count === 0) {
      throw new NotFoundError(`Issue ${id} not found`);
    }

    await releaseUsage(tx, orgId, ResourceType.TASKS);
    return storageKeys;
  });

  await Promise.all(orphanedKeys.map(deleteObject));
}
