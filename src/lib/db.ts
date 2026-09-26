import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';
import { platformPrisma } from './platformPrisma.js';
import { getTenantContext } from './requestContext.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidOrgId(orgId: string): void {
  if (!UUID_RE.test(orgId)) {
    throw new Error(`Invalid organisation id: ${orgId}`);
  }
}

async function runWithOrgContext<T>(
  client: PrismaClient,
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertValidOrgId(orgId);

  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.org_id = '${orgId}';`);
    return fn(tx);
  });
}

/**
 * Runs `fn` inside a transaction with `app.org_id` set for the session, so
 * RLS policies on tenant-scoped tables (User, Project, Issue, UsageCounter)
 * admit rows belonging to `orgId`. Use this when a route needs several
 * statements (e.g. an atomic limit-check-and-create) to run atomically —
 * `getTenantClient` below wraps each call in its own transaction, so it
 * can't give that. Runs over the `app_user` connection.
 */
export function withOrgContext<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return runWithOrgContext(prisma, orgId, fn);
}

/**
 * Same as `withOrgContext`, but over the read-only `platform_reader`
 * connection (see create_platform_reader_role migration) — used exclusively
 * by platform-admin routes that need RLS-scoped access to one organisation's
 * metadata (e.g. its user directory) without the full CRUD grants `app_user`
 * has on tenant content tables.
 */
export function withPlatformOrgContext<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return runWithOrgContext(platformPrisma, orgId, fn);
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
