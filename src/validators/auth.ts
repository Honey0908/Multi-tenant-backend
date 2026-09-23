import { z } from 'zod';

export const signupSchema = z.object({
  organisationName: z.string().trim().min(2).max(120),
  organisationSlug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with hyphens'),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
});

export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;
