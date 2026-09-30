import { randomUUID } from 'node:crypto';
import { platformPrisma } from '../lib/platformPrisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { withOrgContext } from '../lib/db.js';
import { initUsageCounters } from '../lib/usageCounters.js';
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
