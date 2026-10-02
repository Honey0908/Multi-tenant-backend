import type { RequestHandler } from 'express';
import { verifyAccessToken, type TenantTokenPayload } from '../lib/jwt.js';
import { runInTenantContext } from '../lib/requestContext.js';
import { UnauthorizedError } from '../lib/errors.js';

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantTokenPayload;
    }
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(new UnauthorizedError('Missing bearer token'));
    return;
  }

  let payload: TenantTokenPayload;
  try {
    payload = verifyAccessToken(header.slice('Bearer '.length));
  } catch {
    next(new UnauthorizedError('Invalid or expired token'));
    return;
  }

  req.tenant = payload;
  runInTenantContext(payload, () => next());
};
