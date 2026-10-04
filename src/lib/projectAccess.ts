import type { Prisma } from '../generated/prisma/client.js';
import type { Role } from '../generated/prisma/enums.js';
import { getTenantContext } from './requestContext.js';
import { NotFoundError } from './errors.js';

/**
 * Tenant isolation (RLS) keeps organisations apart; project membership keeps
 * users apart *within* one. ORG_ADMINs (and PLATFORM_ADMINs, who only ever
 * act inside their own ops org) see every project in the org; an ORG_MEMBER
 * sees only projects they have a ProjectMember row for.
 */
export function isOrgAdmin(role: Role): boolean {
  return role === 'ORG_ADMIN' || role === 'PLATFORM_ADMIN';
}

/**
 * Prisma `where` fragment restricting Project queries to what the caller may
 * see. Empty for admins; for members, "has a membership row". Spread it into
 * any `project.findMany/findFirst/count` so filtering and paging both stay in
 * Postgres.
 */
export function visibleProjectsFilter(): Prisma.ProjectWhereInput {
  const { role, userId } = getTenantContext();
  return isOrgAdmin(role) ? {} : { members: { some: { user_id: userId } } };
}

/**
 * Throws NotFoundError unless the caller may see `projectId`. 404, never 403,
 * for a project the caller isn't a member of: a 403 would confirm the
 * project exists, which is itself information the caller shouldn't have.
 * Must run inside a tenant-scoped transaction so RLS also applies.
 */
export async function assertProjectAccess(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  const project = await tx.project.findFirst({
    where: { id: projectId, ...visibleProjectsFilter() },
    select: { id: true },
  });
  if (!project) {
    throw new NotFoundError(`Project ${projectId} not found`);
  }
}
