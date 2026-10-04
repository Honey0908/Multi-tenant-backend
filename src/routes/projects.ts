import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/tenantContext.js';
import { requireRole } from '../middleware/requireRole.js';
import { createProjectSchema, updateProjectSchema } from '../validators/project.js';
import { paginationQuerySchema } from '../lib/pagination.js';
import { createProject, listProjects, getProject, updateProject, deleteProject } from '../services/projectService.js';
import { logger } from '../lib/logger.js';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

// Creating, editing and deleting projects is an admin action; members can
// only read the projects they've been added to (see lib/projectAccess.ts).
const requireOrgAdmin = requireRole('ORG_ADMIN', 'PLATFORM_ADMIN');

projectsRouter.post('/', requireOrgAdmin, async (req, res, next) => {
  try {
    const input = createProjectSchema.parse(req.body);
    const project = await createProject(input);
    logger.info({ projectId: project.id, organisationId: project.organisation_id }, 'project created');
    res.status(201).json(project);
  } catch (error) {
    next(error);
  }
});

projectsRouter.get('/', async (req, res, next) => {
  try {
    const pagination = paginationQuerySchema.parse(req.query);
    res.json(await listProjects(pagination));
  } catch (error) {
    next(error);
  }
});

projectsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    res.json(await getProject(id));
  } catch (error) {
    next(error);
  }
});

projectsRouter.patch('/:id', requireOrgAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = updateProjectSchema.parse(req.body);
    res.json(await updateProject(id, input));
  } catch (error) {
    next(error);
  }
});

projectsRouter.delete('/:id', requireOrgAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    await deleteProject(id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
