import { randomUUID } from 'node:crypto';
import { platformPrisma } from '../lib/platformPrisma.js';
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
    const existing = await tx.organisation.findUnique({ where: { slug: input.slug } });
    if (existing) {
      throw new ConflictError(`Organisation slug "${input.slug}" is already taken`);
    }

    const defaultPlan = await tx.subscriptionPlan.findUnique({ where: { name: DEFAULT_PLAN_NAME } });
    if (!defaultPlan) {
      throw new Error(`Default plan "${DEFAULT_PLAN_NAME}" is not seeded — run \`npm run db:seed\``);
    }

    const organisation = await tx.organisation.create({
      data: {
        id: orgId,
        name: input.name,
        slug: input.slug,
        plan_id: defaultPlan.id,
      },
      include: { plan: true },
    });

    // No user yet — this platform-admin path creates a bare org; usage
    // starts at zero across the board until someone is added to it.
    await initUsageCounters(tx, orgId, defaultPlan);

    return organisation;
  });
}

export async function getOrganisationById(id: string) {
  return platformPrisma.organisation.findUnique({ where: { id }, include: { plan: true } });
}
