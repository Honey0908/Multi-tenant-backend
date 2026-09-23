import { tenantDb } from '../lib/db.js';
import { getTenantContext } from '../lib/requestContext.js';
import { NotFoundError } from '../lib/errors.js';
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

  return tenantDb().issue.create({
    data: {
      organisation_id: orgId,
      project_id: projectId,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
    },
  });
}

export async function listIssues(projectId: string) {
  await assertProjectExists(projectId);
  return tenantDb().issue.findMany({ where: { project_id: projectId }, orderBy: { created_at: 'asc' } });
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
  const { count } = await tenantDb().issue.deleteMany({ where: { id, project_id: projectId } });
  if (count === 0) {
    throw new NotFoundError(`Issue ${id} not found`);
  }
}
