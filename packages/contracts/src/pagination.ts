/**
 * Pagination contract (P6.3): every list endpoint is bounded, default 20, maximum 100.
 */
import { z } from 'zod'

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

/** Convert a validated page request into SQL LIMIT/OFFSET. */
export function toLimitOffset(q: PaginationQuery): { limit: number; offset: number } {
  return { limit: q.pageSize, offset: (q.page - 1) * q.pageSize }
}
