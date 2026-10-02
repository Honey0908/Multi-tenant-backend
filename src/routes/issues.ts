import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/tenantContext.js';
import { createIssueSchema, updateIssueSchema } from '../validators/issue.js';
import { paginationQuerySchema } from '../lib/pagination.js';
import { createIssue, listIssues, getIssue, updateIssue, deleteIssue } from '../services/issueService.js';
import { logger } from '../lib/logger.js';

export const issuesRouter = Router({ mergeParams: true });
issuesRouter.use(requireAuth);

issuesRouter.post('/', async (req: Request<{ projectId: string }>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const input = createIssueSchema.parse(req.body);
    const issue = await createIssue(projectId, input);
    logger.info({ issueId: issue.id, projectId }, 'issue created');
    res.status(201).json(issue);
  } catch (error) {
    next(error);
  }
});

issuesRouter.get('/', async (req: Request<{ projectId: string }>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const pagination = paginationQuerySchema.parse(req.query);
    res.json(await listIssues(projectId, pagination));
  } catch (error) {
    next(error);
  }
});

issuesRouter.get('/:id', async (req: Request<{ projectId: string; id: string }>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const id = z.string().uuid().parse(req.params.id);
    res.json(await getIssue(projectId, id));
  } catch (error) {
    next(error);
  }
});

issuesRouter.patch('/:id', async (req: Request<{ projectId: string; id: string }>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const id = z.string().uuid().parse(req.params.id);
    const input = updateIssueSchema.parse(req.body);
    res.json(await updateIssue(projectId, id, input));
  } catch (error) {
    next(error);
  }
});

issuesRouter.delete('/:id', async (req: Request<{ projectId: string; id: string }>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const id = z.string().uuid().parse(req.params.id);
    await deleteIssue(projectId, id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
