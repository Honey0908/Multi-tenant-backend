import { z } from 'zod';

export const createIssueSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).default('TODO'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  assignee_id: z.string().uuid().nullable().optional(),
});

export type CreateIssueInput = z.infer<typeof createIssueSchema>;

export const updateIssueSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    // null unassigns; omitted leaves the assignee untouched.
    assignee_id: z.string().uuid().nullable().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;
