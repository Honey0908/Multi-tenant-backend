import '../src/env.js';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { initUsageCounters } from '../src/lib/usageCounters.js';
import { pgSslConfig } from '../src/lib/pgSsl.js';
import { withOrgContext, withPlatformOrgContext } from '../src/lib/db.js';
import { prisma as appPrisma } from '../src/lib/prisma.js';
import { platformPrisma } from '../src/lib/platformPrisma.js';

// The migration role (DATABASE_URL) is only needed here for the
// SubscriptionPlan catalog, which app_user deliberately has no write
// access to (see add_organisation_rls). It is NOT a genuine
// bypass-everything superuser on managed Postgres (see
// create_auth_reader_role's BYPASSRLS note) — FORCE ROW LEVEL SECURITY
// applies to it exactly as it does to app_user, since it's the tables'
// owner rather than a true superuser. So every Organisation/User/
// UsageCounter operation below goes through the same withOrgContext /
// withPlatformOrgContext helpers the rest of the app uses, not this
// connection directly.
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});
const prisma = new PrismaClient({ adapter });

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
  const enterprisePlan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { name: 'Enterprise' } });

  // platform_reader's cross-org `platform_read_policy` on "Organisation"
  // (see create_platform_reader_role / add_organisation_rls) admits this
  // read with no app.org_id set — the one RLS-protected lookup here that
  // genuinely needs to search across all orgs before any org id is known.
  const existingOrg = await platformPrisma.organisation.findUnique({ where: { slug: PLATFORM_ORG_SLUG } });
  const orgId = existingOrg?.id ?? randomUUID();

  const existingAdmin = await withPlatformOrgContext(orgId, (tx) =>
    tx.user.findUnique({ where: { email: PLATFORM_ADMIN_EMAIL } }),
  );
  if (existingAdmin) {
    return;
  }

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

async function disconnectAll() {
  await Promise.all([prisma.$disconnect(), appPrisma.$disconnect(), platformPrisma.$disconnect()]);
}

main()
  .then(() => disconnectAll())
  .catch(async (error) => {
    console.error(error);
    await disconnectAll();
    process.exit(1);
  });
