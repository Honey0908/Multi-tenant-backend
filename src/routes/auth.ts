import { Router } from 'express';
import { signupSchema, loginSchema } from '../validators/auth.js';
import { signup, login } from '../services/authService.js';
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
