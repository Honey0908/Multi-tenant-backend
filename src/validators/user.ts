import { z } from 'zod';

export const createUserSchema = z.object({
  organisationId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  // PLATFORM_ADMIN is intentionally excluded — never assignable via self/admin registration.
  role: z.enum(['ORG_ADMIN', 'ORG_MEMBER']).default('ORG_MEMBER'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
