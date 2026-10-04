import { withOrgContext, tenantDb } from '../lib/db.js';
import { purgeAttachmentsOfProject } from '../lib/cascade.js';
import { deleteObject } from '../lib/s3.js';
import { getTenantContext } from '../lib/requestContext.js';
import { claimUsage, releaseUsage } from '../lib/usageCounters.js';
import { ResourceType } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import { visibleProjectsFilter } from '../lib/projectAccess.js';
import { NotFoundError } from '../lib/errors.js';
import { paginate, toSkipTake, type PaginationInput } from '../lib/pagination.js';
import type { CreateProjectInput, UpdateProjectInput } from '../validators/project.js';

export async function createProject(input: CreateProjectInput) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    const organisation = await tx.organisation.findUniqueOrThrow({
      where: { id: orgId },
      include: { plan: true },
    });

    // Atomic claim-then-create, not count-then-create: claimUsage is a
    // single conditional UPDATE on the org's UsageCounter row, so Postgres's
    // row lock serializes two concurrent requests racing for the last slot
    // instead of letting both pass a stale count check.
    await claimUsage(tx, orgId, ResourceType.PROJECTS, organisation.plan.name);

    return tx.project.create({
      data: {
        organisation_id: orgId,
        name: input.name,
        description: input.description,
      },
    });
  });
}

export async function listProjects(pagination: PaginationInput) {
  const { orgId } = getTenantContext();

  // Filtering and paging both happen in Postgres — the app never pulls the
  // full set into memory to slice it (see requirement §27/§28).
  return withOrgContext(orgId, async (tx) => {
    const where = visibleProjectsFilter();
    const projects = await tx.project.findMany({
      where,
      orderBy: { created_at: 'asc' },
      ...toSkipTake(pagination),
    });
    const total = await tx.project.count({ where });
    return paginate(projects, total, pagination);
  });
}

export async function getProject(id: string) {
  // findFirst, not findUnique: the membership filter isn't part of the unique
  // key. A project the caller isn't in is indistinguishable from one that
  // doesn't exist.
  const project = await tenantDb().project.findFirst({ where: { id, ...visibleProjectsFilter() } });
  if (!project) {
    throw new NotFoundError(`Project ${id} not found`);
  }
  return project;
}

export async function updateProject(id: string, input: UpdateProjectInput) {
  try {
    return await tenantDb().project.update({ where: { id }, data: input });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new NotFoundError(`Project ${id} not found`);
    }
    throw error;
  }
}

export async function deleteProject(id: string) {
  const { orgId } = getTenantContext();

  // Children are removed explicitly, deepest first, so their quota can be
  // settled from real row counts — `ON DELETE CASCADE` would remove them
  // silently and strand the counters (see lib/cascade.ts). If the project
  // turns out not to exist, the NotFoundError below rolls the whole
  // transaction back, so nothing is deleted.
  const orphanedKeys = await withOrgContext(orgId, async (tx) => {
    const storageKeys = await purgeAttachmentsOfProject(tx, orgId, id);
    const { count: deletedIssues } = await tx.issue.deleteMany({
      where: { project_id: id, organisation_id: orgId },
    });

    const { count } = await tx.project.deleteMany({ where: { id, organisation_id: orgId } });
    if (count === 0) {
      throw new NotFoundError(`Project ${id} not found`);
    }

    await releaseUsage(tx, orgId, ResourceType.PROJECTS);
    if (deletedIssues > 0) {
      await releaseUsage(tx, orgId, ResourceType.TASKS, deletedIssues);
    }
    return storageKeys;
  });

  // Best-effort, after the transaction commits: the DB is the source of
  // truth, so an unreachable storage backend leaves an orphaned object
  // rather than blocking the delete (same contract as deleteAttachment).
  await Promise.all(orphanedKeys.map(deleteObject));
}
