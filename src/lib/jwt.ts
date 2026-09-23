import '../env.js';
import jwt from 'jsonwebtoken';
import type { Role } from '../generated/prisma/enums.js';

export interface TenantTokenPayload {
  userId: string;
  orgId: string;
  role: Role;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const secret = requireEnv('JWT_SECRET');
const expiresIn = process.env.JWT_EXPIRES_IN ?? '1h';

export function signAccessToken(payload: TenantTokenPayload): string {
  return jwt.sign(payload, secret, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
}

export function verifyAccessToken(token: string): TenantTokenPayload {
  const decoded = jwt.verify(token, secret);
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    typeof decoded.userId !== 'string' ||
    typeof decoded.orgId !== 'string' ||
    typeof decoded.role !== 'string'
  ) {
    throw new Error('Malformed token payload');
  }
  return { userId: decoded.userId, orgId: decoded.orgId, role: decoded.role as Role };
}
