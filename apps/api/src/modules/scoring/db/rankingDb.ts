/**
 * SQL for cohorts and the persisted ranking (E07-S02 … E07-S06).
 */
import { query, queryOne, tx } from '../../../db/pool.js'

export interface RunCohortRow {
  run_index_id: number
  challenge_id: number
  cohort_size: number
  floor_used: number
  below_floor: boolean
}

/** Record every cohort a run covers, before any scoring happens (E07-S03 acceptance 1). */
export async function recordCohorts(
  runIndexId: number,
  cohorts: ReadonlyArray<{ challengeId: number; cohortSize: number; floorUsed: number }>,
): Promise<void> {
  for (const cohort of cohorts) {
    await query(
      `INSERT INTO run_cohort (run_index_id, challenge_id, cohort_size, floor_used, below_floor)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (run_index_id, challenge_id) DO UPDATE SET
         cohort_size = EXCLUDED.cohort_size, floor_used = EXCLUDED.floor_used,
         below_floor = EXCLUDED.below_floor, recorded_at = now()`,
      [runIndexId, cohort.challengeId, cohort.cohortSize, cohort.floorUsed,
       cohort.cohortSize < cohort.floorUsed])
  }
}

export async function selectCohorts(runIndexId: number): Promise<RunCohortRow[]> {
  const res = await query<RunCohortRow>(
    `SELECT run_index_id, challenge_id, cohort_size, floor_used, below_floor
       FROM v_scoring_run_cohorts WHERE run_index_id = $1 ORDER BY challenge_id`,
    [runIndexId])
  return res.rows
}

export interface CompositeRow {
  run_index_id: number
  submission_id: number
  challenge_id: number
  team_name: string | null
  composite: number
  fidelity_raw: number | null
  fidelity_normalised: number | null
  cohort_size: number
  normalisation_method: string
  rank_global: number
  rank_in_challenge: number
  tied: boolean
  weight_covered: number
  missing_dimensions: string[]
  partial: boolean
  in_cut_band: boolean
  advisory_decided: boolean
  requires_review: boolean
  review_reasons: string[]
  computed_at: Date
}

export interface CompositeInsert {
  submissionId: number
  challengeId: number
  composite: number
  fidelityRaw: number | null
  fidelityNormalised: number | null
  cohortSize: number
  normalisationMethod: string
  rankGlobal: number
  rankInChallenge: number
  tied: boolean
  weightCovered: number
  missingDimensions: string[]
  partial: boolean
  inCutBand: boolean
  advisoryDecided: boolean
  reviewReasons: string[]
}

export interface SnapshotInsert {
  scoresCounted: number
  submissions: number
  cutLineUsed: number
  bandSizeUsed: number
  minCohortSize: number
  computedBy: string | null
}

/**
 * Replace a run's ranking, atomically.
 *
 * Delete-then-insert inside one transaction rather than upsert: ranks carry a uniqueness
 * constraint per run, so an upsert that moves a submission from rank 4 to rank 3 collides with
 * whoever holds 3 until that row is itself updated. Ordering the updates to avoid that is a
 * puzzle with no payoff — a ranking is a single value, and it is replaced as one.
 */
export async function replaceRanking(
  runIndexId: number,
  rows: readonly CompositeInsert[],
  snapshot: SnapshotInsert,
): Promise<void> {
  await tx(async (client) => {
    await client.query('DELETE FROM submission_composite WHERE run_index_id = $1', [runIndexId])

    for (const row of rows) {
      await client.query(
        `INSERT INTO submission_composite
           (run_index_id, submission_id, challenge_id, composite, fidelity_raw,
            fidelity_normalised, cohort_size, normalisation_method, rank_global,
            rank_in_challenge, tied, weight_covered, missing_dimensions, partial,
            in_cut_band, advisory_decided, requires_review, review_reasons)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text[],$14,$15,$16,$17,$18::text[])`,
        [runIndexId, row.submissionId, row.challengeId, row.composite, row.fidelityRaw,
         row.fidelityNormalised, row.cohortSize, row.normalisationMethod, row.rankGlobal,
         row.rankInChallenge, row.tied, row.weightCovered, row.missingDimensions, row.partial,
         row.inCutBand, row.advisoryDecided,
         row.reviewReasons.length > 0, row.reviewReasons])
    }

    await client.query(
      `INSERT INTO ranking_snapshot
         (run_index_id, scores_counted, submissions, cut_line_used, band_size_used,
          min_cohort_size, computed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_index_id) DO UPDATE SET
         scores_counted = EXCLUDED.scores_counted, submissions = EXCLUDED.submissions,
         cut_line_used = EXCLUDED.cut_line_used, band_size_used = EXCLUDED.band_size_used,
         min_cohort_size = EXCLUDED.min_cohort_size, computed_by = EXCLUDED.computed_by,
         computed_at = now()`,
      [runIndexId, snapshot.scoresCounted, snapshot.submissions, snapshot.cutLineUsed,
       snapshot.bandSizeUsed, snapshot.minCohortSize, snapshot.computedBy])
  })
}

/** The stored ranking, read from the published view (P1.3). */
export async function selectRanking(runIndexId: number): Promise<CompositeRow[]> {
  const res = await query<CompositeRow>(
    'SELECT * FROM v_scoring_ranking WHERE run_index_id = $1 ORDER BY rank_global',
    [runIndexId])
  return res.rows
}

export async function selectCutBand(runIndexId: number): Promise<CompositeRow[]> {
  const res = await query<CompositeRow>(
    `SELECT * FROM v_scoring_ranking WHERE run_index_id = $1 AND in_cut_band
      ORDER BY rank_global`,
    [runIndexId])
  return res.rows
}

/**
 * Everything flagged for a person to look at, wherever it sits in the order.
 *
 * Deliberately not the same query as the cut band: a submission whose cohort was too small to
 * normalise needs a human eye at rank 40 exactly as much as at rank 24.
 */
export async function selectRequiringReview(runIndexId: number): Promise<CompositeRow[]> {
  const res = await query<CompositeRow>(
    `SELECT * FROM v_scoring_ranking WHERE run_index_id = $1 AND requires_review
      ORDER BY rank_global`,
    [runIndexId])
  return res.rows
}

export interface SnapshotRow {
  run_index_id: number
  scores_counted: number
  submissions: number
  cut_line_used: number
  band_size_used: number
  min_cohort_size: number
  computed_by: string | null
  computed_at: Date
}

export async function selectSnapshot(runIndexId: number): Promise<SnapshotRow | null> {
  return queryOne<SnapshotRow>(
    'SELECT * FROM ranking_snapshot WHERE run_index_id = $1', [runIndexId])
}

/** How many criterion scores the run holds now — compared against the snapshot to spot staleness. */
export async function countScores(runIndexId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM criterion_score WHERE run_index_id = $1', [runIndexId])
  return row?.n ?? 0
}

export interface DimensionScoreInsert {
  submissionId: number
  dimension: string
  score: number | null
  dataQuality: string
  scoredCount: number
  totalCount: number
  weightCovered: number
  weight: number
  excluded: Array<{ criterionId: string; reason: string }>
}

/** Replace a run's dimension breakdown, in step with its ranking (E08-S01 acceptance 1). */
export async function replaceDimensionScores(
  runIndexId: number, rows: readonly DimensionScoreInsert[],
): Promise<void> {
  await tx(async (client) => {
    await client.query(
      'DELETE FROM submission_dimension_score WHERE run_index_id = $1', [runIndexId])

    for (const row of rows) {
      await client.query(
        `INSERT INTO submission_dimension_score
           (run_index_id, submission_id, dimension, score, data_quality, scored_count,
            total_count, weight_covered, weight, excluded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [runIndexId, row.submissionId, row.dimension, row.score, row.dataQuality,
         row.scoredCount, row.totalCount, row.weightCovered, row.weight,
         JSON.stringify(row.excluded)])
    }
  })
}

export interface DimensionScoreRow {
  submission_id: number
  dimension: string
  score: number | null
  data_quality: string
  scored_count: number
  total_count: number
  weight_covered: number
  weight: number
  excluded: Array<{ criterionId: string; reason: string }>
}

export async function selectDimensionScores(
  runIndexId: number, submissionId?: number,
): Promise<DimensionScoreRow[]> {
  const res = await query<DimensionScoreRow>(
    `SELECT * FROM v_scoring_dimension_scores
      WHERE run_index_id = $1 AND ($2::bigint IS NULL OR submission_id = $2)
      ORDER BY submission_id, dimension`,
    [runIndexId, submissionId ?? null])
  return res.rows
}
