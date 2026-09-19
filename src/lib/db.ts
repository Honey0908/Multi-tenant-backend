import type { Prisma } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction with `app.org_id` set for the session, so
 * RLS policies on tenant-scoped tables (User, Project, Issue) admit rows
 * belonging to `orgId`. Superseded in Milestone 2 by a Prisma Client
 * Extension (`getTenantClient`) driven by request-scoped AsyncLocalStorage;
 * this is the minimal version needed until the auth/tenant-context
 * middleware exists.
 */
export async function withOrgContext<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(orgId)) {
    throw new Error(`Invalid organisation id: ${orgId}`);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.org_id = '${orgId}';`);
    return fn(tx);
  });
}
