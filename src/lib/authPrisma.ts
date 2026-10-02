import '../env.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

// Used ONLY by the login lookup: finding a user by email before their
// orgId is known, which RLS on "User" otherwise forbids. `auth_reader` can
// SELECT from "User" and nothing else — see create_auth_reader_role
// migration. Never use this client for any other query.
const adapter = new PrismaPg({ connectionString: process.env.AUTH_DATABASE_URL });
export const authPrisma = new PrismaClient({ adapter });
