import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/tenantContext.js';
import { requireRole } from '../middleware/requireRole.js';
import { createUserSchema } from '../validators/user.js';
import { createUser, listOrganisationUsers } from '../services/userService.js';
import { logger } from '../lib/logger.js';

export const usersRouter = Router();
usersRouter.use(requireAuth, requireRole('ORG_ADMIN', 'PLATFORM_ADMIN'));

usersRouter.post('/', async (req, res, next) => {
  try {
    const input = createUserSchema.parse(req.body);
    const user = await createUser(input);
    logger.info({ userId: user.id, organisationId: user.organisation_id }, 'user created');
    res.status(201).json(user);
  } catch (error) {
    next(error);
  }
});

// Platform-admin only: reads across the whole platform, not scoped to the caller's own org.
export const organisationUsersRouter = Router({ mergeParams: true });
organisationUsersRouter.use(requireAuth, requireRole('PLATFORM_ADMIN'));

organisationUsersRouter.get('/', async (req: Request<{ orgId: string }>, res, next) => {
  try {
    const organisationId = z.string().uuid().parse(req.params.orgId);
    const users = await listOrganisationUsers(organisationId);
    res.json(users);
  } catch (error) {
    next(error);
  }
});
