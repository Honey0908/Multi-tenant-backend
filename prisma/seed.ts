import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { prisma } from '../src/lib/prisma.js';
import { withOrgContext } from '../src/lib/db.js';
import { initUsageCounters } from '../src/lib/usageCounters.js';

const PLATFORM_ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL ?? 'platform-admin@taskflow.local';
const PLATFORM_ADMIN_PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD ?? 'change-me-in-production';
const PLATFORM_ORG_SLUG = 'platform-ops';

const PLAN_TIERS = [
  {
    name: 'Starter',
    max_users: 5,
    max_projects: 3,
    max_tasks: 100,
    max_storage_mb: 1024,
  },
  {
    name: 'Professional',
    max_users: 25,
    max_projects: 20,
    max_tasks: 1000,
    max_storage_mb: 10240,
  },
  {
    name: 'Enterprise',
    max_users: 100,
    max_projects: 100,
    max_tasks: 10000,
    max_storage_mb: 102400,
  },
];

async function main() {
  for (const plan of PLAN_TIERS) {
    await prisma.subscriptionPlan.upsert({
      where: { name: plan.name },
      update: plan,
      create: plan,
    });
  }

  await seedPlatformAdmin();
}

// Neither /api/auth/signup nor POST /api/users can ever create a
// PLATFORM_ADMIN (see validators/auth.ts, validators/user.ts) — by design,
// there is no API path to self-escalate into that role. The only way one
// exists is bootstrapped here, in an internal "platform-ops" organisation
// that never appears in tenant-facing routes. Re-running the seed is a
// no-op once this admin already exists.
async function seedPlatformAdmin() {
  const existingAdmin = await prisma.user.findUnique({ where: { email: PLATFORM_ADMIN_EMAIL } });
  if (existingAdmin) {
    return;
  }

  const enterprisePlan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { name: 'Enterprise' } });
  const existingOrg = await prisma.organisation.findUnique({ where: { slug: PLATFORM_ORG_SLUG } });
  const orgId = existingOrg?.id ?? randomUUID();
  const passwordHash = await argon2.hash(PLATFORM_ADMIN_PASSWORD);

  await withOrgContext(orgId, async (tx) => {
    if (!existingOrg) {
      await tx.organisation.create({
        data: { id: orgId, name: 'Platform Operations', slug: PLATFORM_ORG_SLUG, plan_id: enterprisePlan.id },
      });
      await initUsageCounters(tx, orgId, enterprisePlan, 1);
    }

    await tx.user.create({
      data: {
        organisation_id: orgId,
        email: PLATFORM_ADMIN_EMAIL,
        password_hash: passwordHash,
        first_name: 'Platform',
        last_name: 'Admin',
        role: 'PLATFORM_ADMIN',
      },
    });
  });

  console.log(`Seeded platform admin: ${PLATFORM_ADMIN_EMAIL}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
