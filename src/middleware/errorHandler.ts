import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ code: 'VALIDATION_ERROR', fields: err.flatten().fieldErrors });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ code: err.code, message: err.message });
    return;
  }

  logger.error({ err }, 'unhandled error');
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
};
