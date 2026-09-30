import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * `?page=&limit=` on any list endpoint. Both are optional, and `limit` is
 * capped: an unbounded page size would let one request pull a whole table
 * into memory, which is the thing pagination exists to prevent.
 *
 * `z.coerce` because query strings arrive as strings — an invalid value
 * (`?page=abc`, `?limit=0`) fails here at the API boundary and returns
 * VALIDATION_ERROR before any query runs.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationInput = z.infer<typeof paginationQuerySchema>;

export interface Paginated<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Prisma `skip`/`take` for a validated page request. */
export function toSkipTake({ page, limit }: PaginationInput): { skip: number; take: number } {
  return { skip: (page - 1) * limit, take: limit };
}

/** Wraps a page of rows in the response envelope every list endpoint returns. */
export function paginate<T>(items: T[], total: number, { page, limit }: PaginationInput): Paginated<T> {
  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
