/**
 * All SQL for score runs and criterion scores (P1.2).
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'
import type { ScoredCriterion } from '../services/criterionScorer.js'

export interface ScoreRunRow {
  run_index_id: number
  run_index: number
  cohort_key: string
  rubric_versions: Record<string, number>
  model: string
  ledger_run_id: number | null
  status: string
  started_by: string | null
  started_at: Date
  finished_at: Date | null
  cost_usd: number
  error: string | null
  pinned_config?: Record<string, unknown>
}

export async function insertScoreRun(input: {
  runIndex: 1 | 2
  cohortKey: string
  rubricVersions: Record<string, number>
  model: string
  ledgerRunId: number | null
  startedBy: string | null
  /** Every outcome setting and flag as they stood at open (E14-S01). */
  pinnedConfig?: unknown
}): Promise<ScoreRunRow> {
  const row = await queryOne<ScoreRunRow>(
    `INSERT INTO score_run (run_index, cohort_key, rubric_versions, model, ledger_run_id,
                            started_by, pinned_config)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb) RETURNING *`,
    [input.runIndex, input.cohortKey, JSON.stringify(input.rubricVersions),
     input.model, input.ledgerRunId, input.startedBy,
     JSON.stringify(input.pinnedConfig ?? {})])
  if (!row) throw new Error('insertScoreRun returned no row')
  return row
}

/** The score run for a cohort and index, if one exists. Used to resume rather than duplicate. */
export async function selectScoreRunFor(
  cohortKey: string, runIndex: number,
): Promise<ScoreRunRow | null> {
  return queryOne<ScoreRunRow>(
    'SELECT * FROM score_run WHERE cohort_key = $1 AND run_index = $2',
    [cohortKey, runIndex])
}

export async function selectScoreRun(runIndexId: number): Promise<ScoreRunRow | null> {
  return queryOne<ScoreRunRow>('SELECT * FROM score_run WHERE run_index_id = $1', [runIndexId])
}

export async function selectRunsForCohort(cohortKey: string): Promise<ScoreRunRow[]> {
  const res = await query<ScoreRunRow>(
    'SELECT * FROM score_run WHERE cohort_key = $1 ORDER BY run_index', [cohortKey])
  return res.rows
}

export async function finishScoreRun(
  runIndexId: number, status: string, error: string | null,
): Promise<void> {
  await query(
    `UPDATE score_run SET status = $2, error = $3, finished_at = now(),
            cost_usd = COALESCE((SELECT SUM(cost_usd) FROM criterion_score
                                  WHERE run_index_id = $1), 0)
      WHERE run_index_id = $1`,
    [runIndexId, status, error])
}

export interface CriterionScoreRow {
  id: number
  run_index_id: number
  submission_id: number
  criterion_id: number
  dimension: string
  rubric_id: number
  rubric_version: number
  rubric_hash: string
  raw_score: number | null
  non_score: string | null
  confidence: number
  rationale: string
  anchor_matched: string | null
  /**
   * File-and-line evidence, each item carrying the verdict of checking it against the scan
   * (E13). Stored with the score rather than recomputed at read time: a reviewer and an appeal
   * packet months later must see the verdict that was reached when the score was taken, not one
   * reached against a scan that has since been superseded.
   */
  evidence: Array<{
    path: string; lineStart: number; lineEnd: number; excerpt: string
    verdict?: string; verdictReason?: string
  }>
  context_bytes: number
  context_truncated: boolean
  files_searched: number
  model: string | null
  attempts: number
  cost_usd: number
  scored_at: Date
}

/**
 * Record one criterion score.
 *
 * Idempotent on (run, submission, criterion) so a resumed run cannot produce duplicate score
 * rows (E10-S04 acceptance 3) — and so a re-run of a failed criterion replaces its failure
 * rather than accumulating rows nobody can choose between.
 */
export async function upsertCriterionScore(input: {
  runIndexId: number
  submissionId: number
  rubricId: number
  rubricVersion: number
  rubricHash: string
  scored: ScoredCriterion
}, client?: DbClient): Promise<{ row: CriterionScoreRow; replaced: PriorScore | null }> {
  const s = input.scored

  // What was there before, if anything. A re-score overwrites the row, so this is the only
  // moment the previous value can be captured — and "the score changed after I looked at it"
  // is exactly what an appeal asks about (E09-S01).
  const prior = await queryOne<PriorScore>(
    `SELECT raw_score, non_score, rationale, model, scored_at FROM criterion_score
      WHERE run_index_id = $1 AND submission_id = $2 AND criterion_id = $3`,
    [input.runIndexId, input.submissionId, s.criterionId], client)

  const row = await queryOne<CriterionScoreRow>(
    `INSERT INTO criterion_score
       (run_index_id, submission_id, criterion_id, dimension, rubric_id, rubric_version,
        rubric_hash, raw_score, non_score, confidence, rationale, anchor_matched, evidence,
        context_bytes, context_truncated, files_searched, model, attempts, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (run_index_id, submission_id, criterion_id) DO UPDATE SET
       raw_score = EXCLUDED.raw_score, non_score = EXCLUDED.non_score,
       confidence = EXCLUDED.confidence, rationale = EXCLUDED.rationale,
       anchor_matched = EXCLUDED.anchor_matched, evidence = EXCLUDED.evidence,
       context_bytes = EXCLUDED.context_bytes, context_truncated = EXCLUDED.context_truncated,
       files_searched = EXCLUDED.files_searched, model = EXCLUDED.model,
       attempts = EXCLUDED.attempts, cost_usd = EXCLUDED.cost_usd, scored_at = now()
     RETURNING *`,
    [input.runIndexId, input.submissionId, s.criterionId, s.dimension, input.rubricId,
     input.rubricVersion, input.rubricHash, s.rawScore, s.nonScore, s.confidence,
     s.rationale, s.anchorMatched, JSON.stringify(s.evidence), s.contextBytes,
     s.contextTruncated, s.filesSearched, s.model, s.attempts, s.costUsd],
    client)
  if (!row) throw new Error('upsertCriterionScore returned no row')

  const changed = prior !== null
    && (prior.raw_score !== row.raw_score || prior.non_score !== row.non_score)
  return { row, replaced: changed ? prior : null }
}

/** A score as it stood before it was overwritten. */
export interface PriorScore {
  raw_score: number | null
  non_score: string | null
  rationale: string
  model: string | null
  scored_at: Date
}

export async function selectScoresFor(
  runIndexId: number, submissionId: number,
): Promise<CriterionScoreRow[]> {
  const res = await query<CriterionScoreRow>(
    `SELECT * FROM criterion_score WHERE run_index_id = $1 AND submission_id = $2
      ORDER BY dimension, criterion_id`,
    [runIndexId, submissionId])
  return res.rows
}

/** Criteria already scored in this run, so a resume skips them (E10-S04 acceptance 2). */
export async function selectScoredCriterionIds(
  runIndexId: number, submissionId: number,
): Promise<Set<number>> {
  const res = await query<{ criterion_id: number }>(
    `SELECT criterion_id FROM criterion_score
      WHERE run_index_id = $1 AND submission_id = $2 AND non_score IS DISTINCT FROM 'SCORING_FAILED'`,
    [runIndexId, submissionId])
  return new Set(res.rows.map((r) => r.criterion_id))
}

/** Submissions with at least one score in a run. */
export async function selectScoredSubmissions(runIndexId: number): Promise<number[]> {
  const res = await query<{ submission_id: number }>(
    'SELECT DISTINCT submission_id FROM criterion_score WHERE run_index_id = $1 ORDER BY 1',
    [runIndexId])
  return res.rows.map((r) => r.submission_id)
}

/** How much of a run could not be scored — what an operator watches for (P9.4). */
export async function scoringHealth(runIndexId: number): Promise<{
  total: number; scored: number; insufficient: number; failed: number
}> {
  const row = await queryOne<{
    total: number; scored: number; insufficient: number; failed: number
  }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE raw_score IS NOT NULL)::int AS scored,
            COUNT(*) FILTER (WHERE non_score = 'INSUFFICIENT_EVIDENCE')::int AS insufficient,
            COUNT(*) FILTER (WHERE non_score = 'SCORING_FAILED')::int AS failed
       FROM criterion_score WHERE run_index_id = $1`,
    [runIndexId])
  return row ?? { total: 0, scored: 0, insufficient: 0, failed: 0 }
}

/**
 * Every criterion score in a run, in one query.
 *
 * The composite pass needs all of them at once. Fetching per submission turns one query into
 * fifty, and the cohort normalisation in E07-S02 cannot start until the last one returns.
 */
export async function selectRunDimensionInputs(runIndexId: number): Promise<
  Array<{
    submissionId: number; dimension: string; criterionId: number
    rawScore: number | null; nonScore: string | null
  }>
> {
  const res = await query<{
    submission_id: number; dimension: string; criterion_id: number
    raw_score: number | null; non_score: string | null
  }>(
    `SELECT submission_id, dimension, criterion_id, raw_score, non_score
       FROM v_scoring_criterion_scores WHERE run_index_id = $1
      ORDER BY submission_id, dimension, criterion_id`,
    [runIndexId])
  return res.rows.map((r) => ({
    submissionId: r.submission_id, dimension: r.dimension, criterionId: r.criterion_id,
    rawScore: r.raw_score, nonScore: r.non_score,
  }))
}

/** Which challenge each submission belongs to — cohorts are per challenge (E07-S02). */
export async function selectChallengeOf(
  submissionIds: readonly number[],
): Promise<Map<number, number>> {
  if (submissionIds.length === 0) return new Map()
  const res = await query<{ submission_id: number; challenge_id: number }>(
    'SELECT submission_id, challenge_id FROM v_submissions_submission WHERE submission_id = ANY($1)',
    [submissionIds])
  return new Map(res.rows.map((r) => [r.submission_id, r.challenge_id]))
}

/** Every scoring run, newest first, with what a list needs to show (E08 discoverability). */
export async function listScoreRuns(limit = 50): Promise<Array<ScoreRunRow & {
  submissions: number; ranked: number; shortlist_status: string | null
}>> {
  const res = await query<ScoreRunRow & {
    submissions: number; ranked: number; shortlist_status: string | null
  }>(
    `SELECT sr.*,
            (SELECT COUNT(DISTINCT submission_id)::int FROM criterion_score cs
              WHERE cs.run_index_id = sr.run_index_id)              AS submissions,
            (SELECT COUNT(*)::int FROM submission_composite sc
              WHERE sc.run_index_id = sr.run_index_id)              AS ranked,
            (SELECT status FROM shortlist s
              WHERE s.run_index_id = sr.run_index_id)               AS shortlist_status
       FROM score_run sr
      ORDER BY sr.started_at DESC
      LIMIT $1`,
    [limit])
  return res.rows
}
