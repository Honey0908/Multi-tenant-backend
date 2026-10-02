import { z } from 'zod';

// Allow-list, not a deny-list: an uploaded file's declared content-type must
// be one we're prepared to serve back safely. In particular this excludes
// executables, HTML/SVG (stored-XSS risk if ever served inline from the
// same origin), and other script-bearing types.
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const MAX_FILE_NAME_LENGTH = 255;
// Reject path-separator/traversal characters so file_name can never be used
// to build an unsafe storage key or path.
const SAFE_FILE_NAME_RE = /^[^/\\]+$/;

export const reserveAttachmentSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(MAX_FILE_NAME_LENGTH)
    .regex(SAFE_FILE_NAME_RE, 'fileName must not contain path separators'),
  contentType: z.string().refine((value) => ALLOWED_CONTENT_TYPES.has(value), {
    message: `contentType must be one of: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
  }),
  sizeBytes: z.number().int().positive(),
});

export type ReserveAttachmentInput = z.infer<typeof reserveAttachmentSchema>;
