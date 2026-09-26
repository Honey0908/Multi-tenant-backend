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
