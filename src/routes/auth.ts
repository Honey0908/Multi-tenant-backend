import { Router } from 'express';
import { signupSchema, loginSchema } from '../validators/auth.js';
import { signup, login, getCurrentUser } from '../services/authService.js';
import { requireAuth } from '../middleware/tenantContext.js';
import { logger } from '../lib/logger.js';

export const authRouter = Router();

authRouter.post('/signup', async (req, res, next) => {
  try {
    const input = signupSchema.parse(req.body);
    const result = await signup(input);
    logger.info({ userId: result.user.id, organisationId: result.organisation.id }, 'organisation signed up');
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const result = await login(input);
    logger.info({ userId: result.user.id }, 'user logged in');
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Session restore for the SPA: the frontend holds only an opaque token and
// asks the server who it belongs to, rather than decoding the JWT itself.
authRouter.get('/me', requireAuth, async (_req, res, next) => {
  try {
    res.json(await getCurrentUser());
  } catch (error) {
    next(error);
  }
});

// Stateless tokens can't be revoked server-side without a denylist, so
// logging out is the client discarding its token. The endpoint exists so
// the frontend has one obvious place to call, and so the act is logged.
authRouter.post('/logout', requireAuth, (req, res) => {
  logger.info({ userId: req.tenant?.userId, organisationId: req.tenant?.orgId }, 'user logged out');
  res.status(204).send();
});
