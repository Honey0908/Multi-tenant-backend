import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/tenantContext.js';
import { requireRole } from '../middleware/requireRole.js';
import { createOrganisationSchema } from '../validators/organisation.js';
import { createOrganisation, getOrganisationById, listOrganisations } from '../services/organisationService.js';
import { paginationQuerySchema } from '../lib/pagination.js';
import { NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// Platform-admin only: direct org provisioning and cross-tenant org lookup,
// as opposed to the self-service /api/auth/signup flow every tenant uses.
export const organisationsRouter = Router();
organisationsRouter.use(requireAuth, requireRole('PLATFORM_ADMIN'));

organisationsRouter.get('/', async (req, res, next) => {
  try {
    const pagination = paginationQuerySchema.parse(req.query);
    res.json(await listOrganisations(pagination));
  } catch (error) {
    next(error);
  }
});

organisationsRouter.post('/', async (req, res, next) => {
  try {
    const input = createOrganisationSchema.parse(req.body);
    const organisation = await createOrganisation(input);
    logger.info({ organisationId: organisation.id }, 'organisation created');
    res.status(201).json(organisation);
  } catch (error) {
    next(error);
  }
});

organisationsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const organisation = await getOrganisationById(id);
    if (!organisation) {
      throw new NotFoundError(`Organisation ${id} not found`);
    }
    res.json(organisation);
  } catch (error) {
    next(error);
  }
});
