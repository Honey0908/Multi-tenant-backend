import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/tenantContext.js';
import { requireRole } from '../middleware/requireRole.js';
import { createUserSchema, updateUserSchema } from '../validators/user.js';
import {
  createUser,
  listOrganisationUsers,
  listUsers,
  getUser,
  updateUser,
  deleteUser,
} from '../services/userService.js';
import { paginationQuerySchema } from '../lib/pagination.js';
import { logger } from '../lib/logger.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

// Managing members is an admin action; reading the directory is not — any
// member needs it to see colleagues and pick assignees (see listUsers).
const requireOrgAdmin = requireRole('ORG_ADMIN', 'PLATFORM_ADMIN');

usersRouter.get('/', async (req, res, next) => {
  try {
    const pagination = paginationQuerySchema.parse(req.query);
    res.json(await listUsers(pagination));
  } catch (error) {
    next(error);
  }
});

usersRouter.get('/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    res.json(await getUser(id));
  } catch (error) {
    next(error);
  }
});

usersRouter.post('/', requireOrgAdmin, async (req, res, next) => {
  try {
    const input = createUserSchema.parse(req.body);
    const user = await createUser(input);
    logger.info({ userId: user.id, organisationId: user.organisation_id }, 'user created');
    res.status(201).json(user);
  } catch (error) {
    next(error);
  }
});

usersRouter.patch('/:id', requireOrgAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = updateUserSchema.parse(req.body);
    const user = await updateUser(id, input);
    logger.info({ userId: id, organisationId: user.organisation_id }, 'user updated');
    res.json(user);
  } catch (error) {
    next(error);
  }
});

usersRouter.delete('/:id', requireOrgAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    await deleteUser(id);
    logger.info({ userId: id }, 'user removed');
    res.status(204).send();
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
    const pagination = paginationQuerySchema.parse(req.query);
    res.json(await listOrganisationUsers(organisationId, pagination));
  } catch (error) {
    next(error);
  }
});
