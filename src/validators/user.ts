import { z } from 'zod';

// No organisationId field: the caller's own org comes from their JWT (see
// requireAuth / getTenantContext), never from the request body — accepting
// it as input would let any authenticated user add accounts, including
// ORG_ADMIN ones, into an organisation they don't belong to.
export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  // PLATFORM_ADMIN is intentionally excluded — never assignable via self/admin registration.
  role: z.enum(['ORG_ADMIN', 'ORG_MEMBER']).default('ORG_MEMBER'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

// PLATFORM_ADMIN is excluded here for the same reason as on creation: no
// API path may ever mint or promote into the platform role (see
// prisma/seed.ts, which bootstraps the only one).
export const updateUserSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    role: z.enum(['ORG_ADMIN', 'ORG_MEMBER']).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

export type UpdateUserInput = z.infer<typeof updateUserSchema>;
