/**
 * How a participant list may be ordered and filtered (E40, P1.2).
 *
 * Its own file because `rosterDb` reached its P1.4 limit, and because this is one cohesive thing:
 * the answer to "which orderings and filters may a request ask for", used by both the page query
 * and its count so the two cannot disagree about what they are describing.
 */

/**
 * How a participant list may be ordered (E40).
 *
 * An allow-list mapping to SQL fragments, never a column taken from the request. Each ends with
 * `participant_id` so the sequence is total: two people with the same name can otherwise swap
 * places between pages, and a row is silently seen twice or not at all.
 */
const SORTS: Record<string, string> = {
  name: 'lower(full_name) ASC',
  email: 'lower(email) ASC',
  organisation: 'lower(COALESCE(organisation, \'\')) ASC, lower(full_name) ASC',
  added: 'created_at DESC',
}

export const PARTICIPANT_SORTS = Object.keys(SORTS)

/** The ORDER BY for a requested sort, falling back to name. */
export const participantOrder = (sort?: string): string =>
  SORTS[sort ?? ''] ?? SORTS['name']!

export interface ParticipantFilter {
  /** Matches name, address or organisation. Empty means everyone. */
  search?: string
}

/** The WHERE for a participant list, shared by the page and its count so they cannot disagree. */
export function participantWhere(f: ParticipantFilter, from: number):
{ sql: string; params: unknown[] } {
  if (!f.search || f.search.trim() === '') {
    return { sql: 'WHERE deleted_at IS NULL', params: [] }
  }
  return {
    sql: `WHERE deleted_at IS NULL AND (
            full_name ILIKE $${from} OR email ILIKE $${from}
            OR COALESCE(organisation, '') ILIKE $${from})`,
    params: [`%${f.search.trim()}%`],
  }
}
