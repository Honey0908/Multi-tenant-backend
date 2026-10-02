import '../env.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

// Used ONLY by the platform-admin routes (GET /api/organisations, GET
// /api/organisations/:orgId/users): a narrow, read-only role with SELECT on
// Organisation/SubscriptionPlan/User and nothing else — see
// create_platform_reader_role migration. Every tenant-facing route keeps
// using `app_user` via src/lib/prisma.ts.
const adapter = new PrismaPg({ connectionString: process.env.PLATFORM_DATABASE_URL });
export const platformPrisma = new PrismaClient({ adapter });
