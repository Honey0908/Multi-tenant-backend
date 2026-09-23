import { withOrgContext, tenantDb } from '../lib/db.js';
import { getTenantContext } from '../lib/requestContext.js';
import { Prisma } from '../generated/prisma/client.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { CreateProjectInput, UpdateProjectInput } from '../validators/project.js';

export async function createProject(input: CreateProjectInput) {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    const organisation = await tx.organisation.findUniqueOrThrow({
      where: { id: orgId },
      include: { plan: true },
    });

    const projectCount = await tx.project.count({ where: { organisation_id: orgId } });
    if (projectCount >= organisation.plan.max_projects) {
      throw new ConflictError(
        `Project limit reached: ${projectCount} of ${organisation.plan.max_projects} projects used on the ${organisation.plan.name} plan`,
      );
    }

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
  try {
    await tenantDb().project.delete({ where: { id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new NotFoundError(`Project ${id} not found`);
    }
    throw error;
  }
}
