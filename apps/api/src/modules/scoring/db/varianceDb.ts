/**
 * SQL for run-to-run variance (E06-S06).
 */
import { query, queryOne } from '../../../db/pool.js'

export interface VarianceRow {
  id: number
  cohort_key: string
  submission_id: number
  run_a_id: number
  run_b_id: number
  // NUMERIC columns arrive as JS numbers: the pool registers a type parser for them.
  composite_a: number
  composite_b: number
  delta: number
  rank_a: number
  rank_b: number
  straddles_cut: boolean
  exceeds_threshold: boolean
  threshold_used: number
  cut_line_used: number
  dismissed_at: Date | null
  dismissed_by: string | null
  dismissal_reason: string | null
  computed_at: Date
}

export interface VarianceInput {
  cohortKey: string
  submissionId: number
  runAId: number
  runBId: number
  compositeA: number
  compositeB: number
  delta: number
  rankA: number
  rankB: number
  straddlesCut: boolean
  exceedsThreshold: boolean
  thresholdUsed: number
  cutLineUsed: number
}

/**
 * Record one submission's variance.
 *
 * Recomputing a cohort REPLACES the numbers but deliberately leaves any dismissal in place: a
 * reviewer who has looked at a flag and recorded why it is acceptable should not have to look
 * again because an unrelated submission was re-scored.
 */
export async function upsertVariance(input: VarianceInput): Promise<VarianceRow> {
  const row = await queryOne<VarianceRow>(
    `INSERT INTO score_variance
       (cohort_key, submission_id, run_a_id, run_b_id, composite_a, composite_b, delta,
        rank_a, rank_b, straddles_cut, exceeds_threshold, threshold_used, cut_line_used)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (cohort_key, submission_id) DO UPDATE SET
       run_a_id = EXCLUDED.run_a_id, run_b_id = EXCLUDED.run_b_id,
       composite_a = EXCLUDED.composite_a, composite_b = EXCLUDED.composite_b,
       delta = EXCLUDED.delta, rank_a = EXCLUDED.rank_a, rank_b = EXCLUDED.rank_b,
       straddles_cut = EXCLUDED.straddles_cut,
       exceeds_threshold = EXCLUDED.exceeds_threshold,
       threshold_used = EXCLUDED.threshold_used, cut_line_used = EXCLUDED.cut_line_used,
       computed_at = now()
     RETURNING *`,
    [input.cohortKey, input.submissionId, input.runAId, input.runBId,
     input.compositeA, input.compositeB, input.delta, input.rankA, input.rankB,
     input.straddlesCut, input.exceedsThreshold, input.thresholdUsed, input.cutLineUsed])
  if (!row) throw new Error('upsertVariance returned no row')
  return row
}

export async function selectVariance(cohortKey: string): Promise<VarianceRow[]> {
  const res = await query<VarianceRow>(
    'SELECT * FROM score_variance WHERE cohort_key = $1 ORDER BY delta DESC, submission_id',
    [cohortKey])
  return res.rows
}

/**
 * One row of the published flags view.
 *
 * Typed separately from `VarianceRow` because the view is NOT the table: it carries a derived
 * `dismissed` boolean and omits the run ids and the dismissing actor. Reusing the table's type
 * here would compile happily and hand callers `id` and `run_a_id` fields that are undefined at
 * runtime.
 */
export interface VarianceFlagRow {
  cohort_key: string
  submission_id: number
  // NUMERIC columns arrive as JS numbers: the pool registers a type parser for them.
  composite_a: number
  composite_b: number
  delta: number
  rank_a: number
  rank_b: number
  straddles_cut: boolean
  exceeds_threshold: boolean
  threshold_used: number
  cut_line_used: number
  dismissed: boolean
  dismissal_reason: string | null
  computed_at: Date
}

/** Outstanding flags — what E08-S03 shows a reviewer, read from the published view (P1.3). */
export async function selectOpenFlags(cohortKey: string): Promise<VarianceFlagRow[]> {
  const res = await query<VarianceFlagRow>(
    `SELECT * FROM v_scoring_variance_flags
      WHERE cohort_key = $1 AND NOT dismissed
      ORDER BY straddles_cut DESC, delta DESC, submission_id`,
    [cohortKey])
  return res.rows
}

/**
 * Dismiss a flag, with a reason.
 *
 * The reason is not optional and not decorative: the CHECK constraint in migration 026 refuses a
 * dismissal without at least ten characters of one (acceptance 5). This function does not
 * re-validate that — the database is the enforcement point, and a second copy of the rule here
 * would be the one that drifts.
 */
export async function dismissVariance(
  cohortKey: string, submissionId: number, actor: string, reason: string,
): Promise<VarianceRow | null> {
  return queryOne<VarianceRow>(
    `UPDATE score_variance
        SET dismissed_at = now(), dismissed_by = $3, dismissal_reason = $4
      WHERE cohort_key = $1 AND submission_id = $2
      RETURNING *`,
    [cohortKey, submissionId, actor, reason])
}
