import { tenantDb, withOrgContext } from '../lib/db.js';
import { purgeAttachmentsOfIssue } from '../lib/cascade.js';
import { deleteObject } from '../lib/s3.js';
import { getTenantContext } from '../lib/requestContext.js';
import { claimUsage, releaseUsage } from '../lib/usageCounters.js';
import { ResourceType } from '../generated/prisma/enums.js';
import { NotFoundError } from '../lib/errors.js';
import { paginate, toSkipTake, type PaginationInput } from '../lib/pagination.js';
import type { CreateIssueInput, UpdateIssueInput } from '../validators/issue.js';

async function assertProjectExists(projectId: string): Promise<void> {
  const project = await tenantDb().project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new NotFoundError(`Project ${projectId} not found`);
  }
}

export async function createIssue(projectId: string, input: CreateIssueInput) {
  await assertProjectExists(projectId);
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
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
      },
    });
  });
}

export async function listIssues(projectId: string, pagination: PaginationInput) {
  await assertProjectExists(projectId);
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
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

export async function getIssue(projectId: string, id: string) {
  const issue = await tenantDb().issue.findFirst({ where: { id, project_id: projectId } });
  if (!issue) {
    throw new NotFoundError(`Issue ${id} not found`);
  }
  return issue;
}

export async function updateIssue(projectId: string, id: string, input: UpdateIssueInput) {
  const db = tenantDb();
  const { count } = await db.issue.updateMany({ where: { id, project_id: projectId }, data: input });
  if (count === 0) {
    throw new NotFoundError(`Issue ${id} not found`);
  }
  return db.issue.findUniqueOrThrow({ where: { id } });
}

export async function deleteIssue(projectId: string, id: string) {
  const { orgId } = getTenantContext();

  // Attachments go first so their storage quota is settled from real row
  // counts rather than vanishing silently down the FK cascade (see
  // lib/cascade.ts). An issue id that belongs to a different project fails
  // the delete below and rolls the attachment purge back with it.
  const orphanedKeys = await withOrgContext(orgId, async (tx) => {
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
