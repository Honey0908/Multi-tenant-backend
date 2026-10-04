import { z } from 'zod';

export const addProjectMemberSchema = z.object({
  userId: z.string().uuid(),
});

export type AddProjectMemberInput = z.infer<typeof addProjectMemberSchema>;
