import { randomUUID } from 'node:crypto';
import { platformPrisma } from '../lib/platformPrisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { withOrgContext } from '../lib/db.js';
import { getTenantContext } from '../lib/requestContext.js';
import { initUsageCounters } from '../lib/usageCounters.js';
import { paginate, toSkipTake, type PaginationInput } from '../lib/pagination.js';
import { ConflictError } from '../lib/errors.js';
import type { CreateOrganisationInput } from '../validators/organisation.js';

const DEFAULT_PLAN_NAME = 'Starter';

export async function createOrganisation(input: CreateOrganisationInput) {
  const orgId = randomUUID();

  // Runs inside withOrgContext (not the plain prisma.$transaction it used
  // before) because seeding UsageCounter rows requires app.org_id to be set
  // for RLS — the org row itself has no RLS, but UsageCounter does.
  return withOrgContext(orgId, async (tx) => {
    const defaultPlan = await tx.subscriptionPlan.findUnique({ where: { name: DEFAULT_PLAN_NAME } });
    if (!defaultPlan) {
      throw new Error(`Default plan "${DEFAULT_PLAN_NAME}" is not seeded — run \`npm run db:seed\``);
    }

    // Slug uniqueness comes from the index, not a pre-check — see the same
    // change in authService.signup: RLS on "Organisation" hides other
    // tenants' rows from this connection, and the index is race-free.
    let organisation;
    try {
      organisation = await tx.organisation.create({
        data: {
          id: orgId,
          name: input.name,
          slug: input.slug,
          plan_id: defaultPlan.id,
        },
        include: { plan: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(`Organisation slug "${input.slug}" is already taken`);
      }
      throw error;
    }

    // No user yet — this platform-admin path creates a bare org; usage
    // starts at zero across the board until someone is added to it.
    await initUsageCounters(tx, orgId, defaultPlan);

    return organisation;
  });
}

/**
 * Platform-admin only. Runs with no app.org_id set: "Organisation" now has
 * RLS, and `platform_reader` reads across it through the dedicated
 * platform_read_policy (SELECT-only, org metadata only) added in the
 * add_organisation_rls migration. The same query over `app_user` would
 * return nothing for any org but the caller's own.
 */
export async function getOrganisationById(id: string) {
  return platformPrisma.organisation.findUnique({ where: { id }, include: { plan: true } });
}

/** Resource types in the order the UI presents them, with the key each is reported under. */
const USAGE_KEYS = [
  { resource: 'USERS', key: 'users' },
  { resource: 'PROJECTS', key: 'projects' },
  { resource: 'TASKS', key: 'tasks' },
  { resource: 'STORAGE_BYTES', key: 'storageBytes' },
] as const;

type UsageCounterRow = { resource_type: string; value: bigint; max_limit: bigint };

/** Shared by getOwnUsage and listOrganisations: counter rows -> the {used, limit, remaining} envelope keyed by USAGE_KEYS. */
function buildUsage(counters: UsageCounterRow[]) {
  const byResource = new Map(counters.map((c) => [c.resource_type, c]));

  return Object.fromEntries(
    USAGE_KEYS.map(({ resource, key }) => {
      const counter = byResource.get(resource);
      const used = Number(counter?.value ?? 0);
      const limit = Number(counter?.max_limit ?? 0);
      return [key, { used, limit, remaining: Math.max(limit - used, 0) }];
    }),
  );
}

/**
 * Platform-admin only: every organisation on the platform, paginated, with
 * its plan and aggregate usage — the data the organisation-list screen
 * pages through. Runs over `platform_reader` with no app.org_id set, same
 * as getOrganisationById: "Organisation" and (since the
 * allow_platform_usage_read migration) "UsageCounter" both admit this role
 * across every org via their platform_read_policy.
 *
 * Usage is fetched in one extra query for the whole page (`organisation_id
 * IN (...)`), not one query per org — a page of 20 orgs costs 2 queries
 * total, not 21.
 */
export async function listOrganisations(pagination: PaginationInput) {
  const [organisations, total] = await Promise.all([
    platformPrisma.organisation.findMany({
      include: { plan: true },
      orderBy: { created_at: 'asc' },
      ...toSkipTake(pagination),
    }),
    platformPrisma.organisation.count(),
  ]);

  const counters = await platformPrisma.usageCounter.findMany({
    where: { organisation_id: { in: organisations.map((o) => o.id) } },
  });
  const countersByOrg = new Map<string, UsageCounterRow[]>();
  for (const counter of counters) {
    const forOrg = countersByOrg.get(counter.organisation_id) ?? [];
    forOrg.push(counter);
    countersByOrg.set(counter.organisation_id, forOrg);
  }

  const items = organisations.map((organisation) => ({
    id: organisation.id,
    name: organisation.name,
    slug: organisation.slug,
    status: organisation.status,
    createdAt: organisation.created_at,
    plan: {
      name: organisation.plan.name,
      maxUsers: organisation.plan.max_users,
      maxProjects: organisation.plan.max_projects,
      maxTasks: organisation.plan.max_tasks,
      maxStorageMb: organisation.plan.max_storage_mb,
    },
    usage: buildUsage(countersByOrg.get(organisation.id) ?? []),
  }));

  return paginate(items, total, pagination);
}

/** The caller's own organisation — derived from their token, never from a path parameter. */
export async function getOwnOrganisation() {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, (tx) =>
    tx.organisation.findUniqueOrThrow({ where: { id: orgId }, include: { plan: true } }),
  );
}

/**
 * Live quota for the caller's organisation, read straight from the
 * UsageCounter rows that enforcement actually consults — so what the
 * dashboard shows can never drift from what a create request will decide.
 *
 * Counter values are BIGINT (storage is counted in raw bytes), which
 * JSON.stringify cannot serialize, so each is narrowed to a number here.
 * Byte counts stay far below Number.MAX_SAFE_INTEGER at any plan size.
 */
export async function getOwnUsage() {
  const { orgId } = getTenantContext();

  return withOrgContext(orgId, async (tx) => {
    const organisation = await tx.organisation.findUniqueOrThrow({
      where: { id: orgId },
      include: { plan: true },
    });
    const counters = await tx.usageCounter.findMany({ where: { organisation_id: orgId } });
    const usage = buildUsage(counters);

    return {
      organisation: { id: organisation.id, name: organisation.name, slug: organisation.slug, status: organisation.status },
      plan: {
        name: organisation.plan.name,
        maxUsers: organisation.plan.max_users,
        maxProjects: organisation.plan.max_projects,
        maxTasks: organisation.plan.max_tasks,
        maxStorageMb: organisation.plan.max_storage_mb,
      },
      usage,
    };
  });
}
