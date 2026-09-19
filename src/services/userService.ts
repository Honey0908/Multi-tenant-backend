import argon2 from 'argon2';
import { prisma } from '../lib/prisma.js';
import { withOrgContext } from '../lib/db.js';
import { Prisma } from '../generated/prisma/client.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { CreateUserInput } from '../validators/user.js';

function omitPasswordHash<T extends { password_hash: string }>(user: T) {
  const { password_hash: _password_hash, ...safeUser } = user;
  return safeUser;
}

export async function createUser(input: CreateUserInput) {
  const organisation = await prisma.organisation.findUnique({ where: { id: input.organisationId } });
  if (!organisation) {
    throw new NotFoundError(`Organisation ${input.organisationId} not found`);
  }

  const passwordHash = await argon2.hash(input.password);

  return withOrgContext(input.organisationId, async (tx) => {
    try {
      const user = await tx.user.create({
        data: {
          organisation_id: input.organisationId,
          email: input.email,
          password_hash: passwordHash,
          first_name: input.firstName,
          last_name: input.lastName,
          role: input.role,
        },
      });
      return omitPasswordHash(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(`Email "${input.email}" is already registered`);
      }
      throw error;
    }
  });
}

export async function listOrganisationUsers(organisationId: string) {
  const organisation = await prisma.organisation.findUnique({ where: { id: organisationId } });
  if (!organisation) {
    throw new NotFoundError(`Organisation ${organisationId} not found`);
  }

  return withOrgContext(organisationId, async (tx) => {
    const users = await tx.user.findMany({
      where: { organisation_id: organisationId },
      orderBy: { created_at: 'asc' },
    });
    return users.map(omitPasswordHash);
  });
}
