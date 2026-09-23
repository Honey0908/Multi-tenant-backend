import type { Prisma } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';
import { getTenantContext } from './requestContext.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidOrgId(orgId: string): void {
  if (!UUID_RE.test(orgId)) {
    throw new Error(`Invalid organisation id: ${orgId}`);
  }
}

/**
 * Runs `fn` inside a transaction with `app.org_id` set for the session, so
 * RLS policies on tenant-scoped tables (User, Project, Issue) admit rows
 * belonging to `orgId`. Use this when a route needs several statements
 * (e.g. a count-then-create limit check) to run atomically — `getTenantClient`
 * below wraps each call in its own transaction, so it can't give that.
 */
export async function withOrgContext<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertValidOrgId(orgId);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.org_id = '${orgId}';`);
    return fn(tx);
  });
}

/**
 * A Prisma Client Extension that transparently scopes every query it runs
 * to `orgId`: each call is wrapped in its own transaction that sets
 * `app.org_id` before delegating to the real operation. Callers write plain
 * `client.project.findMany()` with no manual `organisation_id` filter — RLS
 * does the filtering.
 */
export function getTenantClient(orgId: string) {
  assertValidOrgId(orgId);

  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          // `query(args)` returns a deferred PrismaPromise, not an already-running
          // query — passing it to the *interactive* `$transaction(async (tx) => ...)`
          // form silently runs it on the base client's own connection, not `tx`'s,
          // so the SET LOCAL below would have no effect on it. The array/batch form
          // sends both statements down the same connection in one transaction.
          const [, result] = await prisma.$transaction([
            prisma.$executeRawUnsafe(`SET LOCAL app.org_id = '${orgId}';`),
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

/** `getTenantClient`, scoped to the current request's orgId via AsyncLocalStorage. */
export function tenantDb() {
  return getTenantClient(getTenantContext().orgId);
}
