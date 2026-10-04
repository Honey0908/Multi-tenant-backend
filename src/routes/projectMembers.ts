import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/tenantContext.js';
import { requireRole } from '../middleware/requireRole.js';
import { addProjectMemberSchema } from '../validators/projectMember.js';
import { paginationQuerySchema } from '../lib/pagination.js';
import { addProjectMember, listProjectMembers, removeProjectMember } from '../services/projectMemberService.js';
import { logger } from '../lib/logger.js';

export const projectMembersRouter = Router({ mergeParams: true });
projectMembersRouter.use(requireAuth);

const requireOrgAdmin = requireRole('ORG_ADMIN', 'PLATFORM_ADMIN');

projectMembersRouter.post('/', requireOrgAdmin, async (req: Request<{ projectId: string }>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const input = addProjectMemberSchema.parse(req.body);
    const member = await addProjectMember(projectId, input);
    logger.info({ projectId, memberUserId: input.userId }, 'project member added');
    res.status(201).json(member);
  } catch (error) {
    next(error);
  }
});

projectMembersRouter.get('/', async (req: Request<{ projectId: string }>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const pagination = paginationQuerySchema.parse(req.query);
    res.json(await listProjectMembers(projectId, pagination));
  } catch (error) {
    next(error);
  }
});

projectMembersRouter.delete(
  '/:userId',
  requireOrgAdmin,
  async (req: Request<{ projectId: string; userId: string }>, res, next) => {
    try {
      const projectId = z.string().uuid().parse(req.params.projectId);
      const userId = z.string().uuid().parse(req.params.userId);
      await removeProjectMember(projectId, userId);
      logger.info({ projectId, memberUserId: userId }, 'project member removed');
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);
