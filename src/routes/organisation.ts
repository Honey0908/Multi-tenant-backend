import { Router } from 'express';
import { requireAuth } from '../middleware/tenantContext.js';
import { getOwnOrganisation, getOwnUsage } from '../services/organisationService.js';

/**
 * The caller's *own* organisation, singular — distinct from the plural
 * /api/organisations surface, which is platform-admin only and addresses
 * organisations by id. Everything here scopes to the token's org, so there
 * is no id in any path: a tenant cannot even name another organisation.
 */
export const organisationRouter = Router();
organisationRouter.use(requireAuth);

organisationRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await getOwnOrganisation());
  } catch (error) {
    next(error);
  }
});

organisationRouter.get('/usage', async (_req, res, next) => {
  try {
    res.json(await getOwnUsage());
  } catch (error) {
    next(error);
  }
});
