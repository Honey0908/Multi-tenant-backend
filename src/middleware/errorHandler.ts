import type { ErrorRequestHandler, Request } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

function requestMeta(req: Request) {
  return {
    path: req.path,
    method: req.method,
    ...(req.tenant ? { orgId: req.tenant.orgId, userId: req.tenant.userId, role: req.tenant.role } : {}),
  };
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ code: 'VALIDATION_ERROR', fields: err.flatten().fieldErrors });
    return;
  }

  if (err instanceof AppError) {
    // Every rejected AppError is, by construction, a security- or
    // quota-relevant event worth an audit trail: 409 = plan-limit quota
    // failures, 401/403 = rejected or under-privileged auth attempts, 404 on
    // a tenant-scoped route = either a real typo or a cross-tenant access
    // attempt RLS silently turned into "not found" (see tenantContext.ts /
    // db.ts) — either way, worth a structured line to grep for later.
    logger.warn({ ...requestMeta(req), code: err.code, statusCode: err.statusCode }, err.message);
    res.status(err.statusCode).json({ code: err.code, message: err.message });
    return;
  }

  logger.error({ ...requestMeta(req), err }, 'unhandled error');
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
};
