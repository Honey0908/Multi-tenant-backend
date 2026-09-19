import { Router } from 'express';
import { z } from 'zod';
import { createOrganisationSchema } from '../validators/organisation.js';
import { createOrganisation, getOrganisationById } from '../services/organisationService.js';
import { NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const organisationsRouter = Router();

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
