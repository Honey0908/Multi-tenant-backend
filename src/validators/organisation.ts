import { z } from 'zod';

export const createOrganisationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with hyphens'),
});

export type CreateOrganisationInput = z.infer<typeof createOrganisationSchema>;
