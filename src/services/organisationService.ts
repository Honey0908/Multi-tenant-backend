import { prisma } from '../lib/prisma.js';
import { ConflictError } from '../lib/errors.js';
import type { CreateOrganisationInput } from '../validators/organisation.js';

const DEFAULT_PLAN_NAME = 'Starter';

export async function createOrganisation(input: CreateOrganisationInput) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.organisation.findUnique({ where: { slug: input.slug } });
    if (existing) {
      throw new ConflictError(`Organisation slug "${input.slug}" is already taken`);
    }

    const defaultPlan = await tx.subscriptionPlan.findUnique({ where: { name: DEFAULT_PLAN_NAME } });
    if (!defaultPlan) {
      throw new Error(`Default plan "${DEFAULT_PLAN_NAME}" is not seeded — run \`npm run db:seed\``);
    }

    return tx.organisation.create({
      data: {
        name: input.name,
        slug: input.slug,
        plan_id: defaultPlan.id,
      },
      include: { plan: true },
    });
  });
}

export async function getOrganisationById(id: string) {
  return prisma.organisation.findUnique({ where: { id }, include: { plan: true } });
}
