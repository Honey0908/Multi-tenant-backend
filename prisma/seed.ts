import { prisma } from '../src/lib/prisma.js';

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
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
