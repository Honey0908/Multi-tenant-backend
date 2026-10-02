import type { RequestHandler } from 'express';
import type { Role } from '../generated/prisma/enums.js';
import { ForbiddenError } from '../lib/errors.js';

/** Must run after requireAuth — reads the role requireAuth put on req.tenant. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.tenant || !roles.includes(req.tenant.role)) {
      next(new ForbiddenError('You do not have permission to perform this action'));
      return;
    }
    next();
  };
}
