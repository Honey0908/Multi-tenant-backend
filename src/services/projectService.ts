import { withOrgContext, tenantDb } from '../lib/db.js';
import { getTenantContext } from '../lib/requestContext.js';
import { claimUsage, releaseUsage } from '../lib/usageCounters.js';
import { ResourceType } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotFoundError } from '../lib/errors.js';
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

export async function listProjects() {
  return tenantDb().project.findMany({ orderBy: { created_at: 'asc' } });
}

export async function getProject(id: string) {
  const project = await tenantDb().project.findUnique({ where: { id } });
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

  await withOrgContext(orgId, async (tx) => {
    const { count } = await tx.project.deleteMany({ where: { id, organisation_id: orgId } });
    if (count === 0) {
      throw new NotFoundError(`Project ${id} not found`);
    }
    await releaseUsage(tx, orgId, ResourceType.PROJECTS);
  });
}
