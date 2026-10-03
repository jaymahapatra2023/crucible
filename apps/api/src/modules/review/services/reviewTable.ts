/**
 * The ranked table a reviewer works through (E08-S01, E08-S06).
 *
 * Two properties this file exists to guarantee:
 *
 *  - **Counts are backend counts** (S01 acceptance 4, S06 acceptance 1). Every total here comes
 *    from a COUNT over the whole set, never from the length of the page that was fetched. A
 *    table that says "12" because twelve rows arrived is lying whenever the fetch was bounded,
 *    and it lies most convincingly when the bound is rarely hit.
 *  - **Filtering happens in the database.** Filtering a page in the browser produces a count
 *    that describes the page rather than the field, which is the same lie by a different route.
 */
import { query } from '../../../db/pool.js'
import { AppError } from '../../../lib/appError.js'
import { selectSnapshot } from '../../scoring/db/rankingDb.js'

/**
 * What the table may be ordered by (E08-S01 acceptance 2).
 *
 * An allow-list mapping to SQL fragments, never a column name taken from the request. Sorting is
 * the one place a table like this invites string interpolation, and this is the screen that
 * decides who presents.
 */
const SORTS: Record<string, string> = {
  rank: 'r.rank_global ASC',
  composite: 'r.composite DESC',
  team: 'r.team_name ASC NULLS LAST',
  challenge: 'r.challenge_id ASC, r.rank_global ASC',
  flags: 'COALESCE(f.open_flags, 0) DESC, r.rank_global ASC',
  evidence: 'r.weight_covered ASC, r.rank_global ASC',
}

export const SORT_KEYS = Object.keys(SORTS)

/** Dimensions can be sorted by too — "show me the strongest engineering" (acceptance 2). */
const DIMENSIONS = [
  'CHALLENGE_FIDELITY', 'ENGINEERING_QUALITY', 'PRINCIPLES_STANDARDS', 'RUNS', 'ORIGINALITY',
] as const

/**
 * The ORDER BY for a requested sort.
 *
 * A dimension sort puts unscored dimensions LAST regardless of direction. They are not zero,
 * and sorting them to the bottom of an ascending list would present them as the worst results
 * — the same conflation this system spends its effort avoiding everywhere else.
 */
function orderBy(sort: string | undefined, params: unknown[]): string {
  if (sort === undefined) return SORTS['rank']!

  const fixed = SORTS[sort]
  if (fixed) return fixed

  const dimension = DIMENSIONS.find((d) => d === sort)
  if (!dimension) return SORTS['rank']!

  params.push(dimension)
  return `(SELECT ds.score FROM v_scoring_dimension_scores ds
            WHERE ds.run_index_id = r.run_index_id AND ds.submission_id = r.submission_id
              AND ds.dimension = $${params.length}) DESC NULLS LAST, r.rank_global ASC`
}

export interface ReviewFilter {
  challengeId?: number | undefined
  /** Only submissions carrying an undismissed flag with this code. */
  flagCode?: string | undefined
  /** Only submissions with an open flag of any kind. */
  flaggedOnly?: boolean | undefined
  /** Only submissions in the cut band. */
  bandOnly?: boolean | undefined
  decision?: string | undefined
  /** Dimension that must be unscored — for "show me everyone missing Runs". */
  missingDimension?: string | undefined
}

export interface ReviewRow {
  submission_id: number
  challenge_id: number
  team_name: string | null
  composite: number
  rank_global: number
  rank_in_challenge: number
  tied: boolean
  partial: boolean
  in_cut_band: boolean
  advisory_decided: boolean
  requires_review: boolean
  weight_covered: number
  missing_dimensions: string[]
  normalisation_method: string
  open_flags: number
  dismissed_flags: number
  decision: string | null
  decision_reason: string | null
  dimensions: Array<{ dimension: string; score: number | null; dataQuality: string; weight: number }>
}

export interface ReviewTable {
  rows: ReviewRow[]
  /** Rows matching the filter, across the whole field — not the page. */
  total: number
  /** Rows in the run, ignoring the filter, so "12 of 48" is truthful. */
  totalUnfiltered: number
  limit: number
  offset: number
  sort: string
  counts: {
    inCutBand: number
    requiresReview: number
    withOpenFlags: number
    decided: number
  }
}

const SQL_ROWS = `
  SELECT r.submission_id, r.challenge_id, r.team_name, r.composite,
         r.rank_global, r.rank_in_challenge, r.tied, r.partial, r.in_cut_band,
         r.advisory_decided, r.requires_review, r.weight_covered, r.missing_dimensions,
         r.normalisation_method,
         COALESCE(f.open_flags, 0)      AS open_flags,
         COALESCE(f.dismissed_flags, 0) AS dismissed_flags,
         d.decision, d.reason AS decision_reason,
         COALESCE(dim.dimensions, '[]'::jsonb) AS dimensions
    FROM v_scoring_ranking r
    LEFT JOIN (
      SELECT run_index_id, submission_id,
             COUNT(*) FILTER (WHERE NOT dismissed)::int AS open_flags,
             COUNT(*) FILTER (WHERE dismissed)::int     AS dismissed_flags
        FROM v_review_flags GROUP BY run_index_id, submission_id
    ) f ON f.run_index_id = r.run_index_id AND f.submission_id = r.submission_id
    LEFT JOIN v_shortlist_decisions d
      ON d.run_index_id = r.run_index_id AND d.submission_id = r.submission_id
    LEFT JOIN (
      SELECT run_index_id, submission_id,
             jsonb_agg(jsonb_build_object(
               'dimension', dimension, 'score', score,
               'dataQuality', data_quality, 'weight', weight) ORDER BY dimension) AS dimensions
        FROM v_scoring_dimension_scores GROUP BY run_index_id, submission_id
    ) dim ON dim.run_index_id = r.run_index_id AND dim.submission_id = r.submission_id
   WHERE r.run_index_id = $1
`

/**
 * Filter predicates, built as parameterised fragments.
 *
 * Values are always bound, never interpolated: these come from query strings, and a filter that
 * concatenated them would be an injection point on the screen that decides who presents.
 */
function filterSql(filter: ReviewFilter, params: unknown[]): string {
  const clauses: string[] = []

  const add = (sql: string, value: unknown) => {
    params.push(value)
    clauses.push(sql.replace('$?', `$${params.length}`))
  }

  if (filter.challengeId !== undefined) add('r.challenge_id = $?', filter.challengeId)
  if (filter.decision !== undefined) add('d.decision = $?', filter.decision)
  if (filter.bandOnly) clauses.push('r.in_cut_band')
  if (filter.missingDimension !== undefined) {
    add('$? = ANY(r.missing_dimensions)', filter.missingDimension)
  }
  if (filter.flaggedOnly) clauses.push('COALESCE(f.open_flags, 0) > 0')
  if (filter.flagCode !== undefined) {
    add(
      `EXISTS (SELECT 1 FROM v_review_flags vf
                WHERE vf.run_index_id = r.run_index_id
                  AND vf.submission_id = r.submission_id
                  AND vf.code = $? AND NOT vf.dismissed)`,
      filter.flagCode,
    )
  }

  return clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''
}

export async function reviewTable(input: {
  runIndexId: number
  filter?: ReviewFilter
  /** One of SORT_KEYS or a dimension name; anything else falls back to rank order. */
  sort?: string | undefined
  limit?: number
  offset?: number
}): Promise<ReviewTable> {
  if (!(await selectSnapshot(input.runIndexId))) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Scoring run ${input.runIndexId} has no stored ranking. Compute it before reviewing.`,
    )
  }

  const filter = input.filter ?? {}
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
  const offset = Math.max(input.offset ?? 0, 0)

  const rowParams: unknown[] = [input.runIndexId]
  const where = filterSql(filter, rowParams)
  const order = orderBy(input.sort, rowParams)
  rowParams.push(limit, offset)

  const rows = await query<ReviewRow>(
    `${SQL_ROWS}${where} ORDER BY ${order}
      LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
    rowParams)

  // Counted over the whole filtered set, not the page that came back.
  const countParams: unknown[] = [input.runIndexId]
  const countWhere = filterSql(filter, countParams)
  const totals = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM (${SQL_ROWS}${countWhere}) t`, countParams)

  const [unfiltered, counts] = await Promise.all([
    query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM submission_composite WHERE run_index_id = $1',
      [input.runIndexId]),
    summaryCounts(input.runIndexId),
  ])

  return {
    rows: rows.rows,
    total: totals.rows[0]?.n ?? 0,
    totalUnfiltered: unfiltered.rows[0]?.n ?? 0,
    limit,
    offset,
    sort: input.sort ?? 'rank',
    counts,
  }
}

async function summaryCounts(runIndexId: number): Promise<ReviewTable['counts']> {
  const res = await query<{
    in_cut_band: number; requires_review: number; with_open_flags: number; decided: number
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE sc.in_cut_band)::int     AS in_cut_band,
       COUNT(*) FILTER (WHERE sc.requires_review)::int AS requires_review,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM v_review_flags vf
          WHERE vf.run_index_id = sc.run_index_id AND vf.submission_id = sc.submission_id
            AND NOT vf.dismissed))::int                AS with_open_flags,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM v_shortlist_decisions sd
          WHERE sd.run_index_id = sc.run_index_id AND sd.submission_id = sc.submission_id))::int
                                                       AS decided
     FROM submission_composite sc WHERE sc.run_index_id = $1`,
    [runIndexId])

  const row = res.rows[0]
  return {
    inCutBand: row?.in_cut_band ?? 0,
    requiresReview: row?.requires_review ?? 0,
    withOpenFlags: row?.with_open_flags ?? 0,
    decided: row?.decided ?? 0,
  }
}
