import '../env.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

// Deliberately not DATABASE_URL: that role is a Postgres superuser (needed
// for migrations) and superusers bypass Row-Level Security unconditionally.
// The app must connect as the restricted `app_user` role for RLS to apply.
const adapter = new PrismaPg({ connectionString: process.env.APP_DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
