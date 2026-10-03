/**
 * Queries for batch orchestration (E10).
 *
 * Every read goes through a published view (P1.3): a batch touches five modules' worth of state,
 * and reaching into their tables is precisely the coupling the architecture forbids.
 */
import { query, queryOne } from '../../../db/pool.js'

export interface BatchSubject {
  submission_id: number
  challenge_id: number
  team_name: string
}

/**
 * The submissions a run covers, in a DETERMINISTIC order (E10-S01 acceptance 3).
 *
 * Ordered by challenge then submission id — stable, meaningful to a reader, and unaffected by
 * when rows happened to be written. A run planned twice produces the same order, which is what
 * makes a resumed or repeated run comparable with the original.
 *
 * Golden-set repositories are excluded. They are entered through the ordinary path and are
 * therefore VALID submissions against a real challenge; the calibration CLI scores them by naming
 * their own cohort, and this keeps them out of every other run (migration 091).
 */
export async function eligibleSubjects(challengeIds: readonly number[]): Promise<BatchSubject[]> {
  const res = await query<BatchSubject>(
    `SELECT submission_id, challenge_id, team_name
       FROM v_submissions_submission
      WHERE validation_status = 'VALID'
        AND (cardinality($1::bigint[]) = 0 OR challenge_id = ANY($1))
        -- A golden entry is reference material, not an entrant. It is a VALID submission against
        -- the same challenge (that is what makes calibration measure the real pipeline), so
        -- without this a real cohort would rank the reference repositories alongside the teams
        -- and every position near the cut line would be computed from a contaminated cohort.
        AND submission_id NOT IN (SELECT submission_id FROM v_calibration_golden_submission)
      ORDER BY challenge_id, submission_id`,
    [challengeIds])
  return res.rows
}

/**
 * Exactly these submissions, in the same deterministic order — for a run that names its own
 * subjects (calibration). Golden entries are reachable only this way, and a named submission
 * that never validated is dropped here rather than failing every stage later.
 */
export async function namedSubjects(submissionIds: readonly number[]): Promise<BatchSubject[]> {
  const res = await query<BatchSubject>(
    `SELECT submission_id, challenge_id, team_name
       FROM v_submissions_submission
      WHERE validation_status = 'VALID'
        AND submission_id = ANY($1::bigint[])
      ORDER BY challenge_id, submission_id`,
    [submissionIds])
  return res.rows
}

/** Stage durations measured in this run, for the wall-clock estimate (E10-S02 acceptance 3). */
export async function stageDurations(runId: number, stage: string): Promise<number[]> {
  const res = await query<{ duration_ms: number }>(
    `SELECT duration_ms FROM run_stage_result
      WHERE run_id = $1 AND stage = $2 AND outcome IN ('ok', 'warning')
      ORDER BY id DESC LIMIT 50`,
    [runId, stage])
  return res.rows.map((r) => r.duration_ms)
}

/**
 * Durations from earlier runs, so the FIRST run of an evening can still be estimated.
 *
 * Without this, an estimate only appears once a run is well under way — which is after the
 * operator has decided whether to start it.
 */
export async function historicalDurations(stage: string): Promise<number[]> {
  const res = await query<{ duration_ms: number }>(
    `SELECT duration_ms FROM run_stage_result
      WHERE stage = $1 AND outcome IN ('ok', 'warning')
      ORDER BY id DESC LIMIT 100`,
    [stage])
  return res.rows.map((r) => r.duration_ms)
}

export interface ProgressRow {
  run_id: number
  stage: string
  current_subject: string | null
  current_label: string | null
  completed: number
  total: number
  estimated_finish_at: Date | null
  projected_cost_usd: number | null
  updated_at: Date
}

/** Write where the run is now, so progress survives a page reload (E10-S05 acceptance 2). */
export async function upsertProgress(input: {
  runId: number
  stage: string
  currentSubject: string | null
  currentLabel: string | null
  completed: number
  total: number
  estimatedFinishAt: Date | null
  projectedCostUsd: number | null
}): Promise<void> {
  await query(
    `INSERT INTO run_progress
       (run_id, stage, current_subject, current_label, completed, total,
        estimated_finish_at, projected_cost_usd, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (run_id) DO UPDATE SET
       stage = EXCLUDED.stage, current_subject = EXCLUDED.current_subject,
       current_label = EXCLUDED.current_label, completed = EXCLUDED.completed,
       total = EXCLUDED.total, estimated_finish_at = EXCLUDED.estimated_finish_at,
       projected_cost_usd = EXCLUDED.projected_cost_usd, updated_at = now()`,
    [input.runId, input.stage, input.currentSubject, input.currentLabel,
     input.completed, input.total, input.estimatedFinishAt, input.projectedCostUsd])
}

export async function selectProgress(runId: number): Promise<ProgressRow | null> {
  return queryOne<ProgressRow>('SELECT * FROM run_progress WHERE run_id = $1', [runId])
}

export interface StageFailure {
  stage: string
  subject_id: string | null
  message: string
  attempt: number
}

/** Every failure in a run, for the summary (E10-S04 acceptance 4). */
export async function runFailures(runId: number): Promise<StageFailure[]> {
  const res = await query<StageFailure>(
    `SELECT stage, subject_id, message, attempt FROM run_stage_result
      WHERE run_id = $1 AND outcome = 'failed'
      ORDER BY stage, subject_id`,
    [runId])
  return res.rows
}

/** Per-stage counts for the progress endpoint. */
export async function stageCounts(runId: number): Promise<
  Array<{ stage: string; ok: number; failed: number; skipped: number; warning: number }>
> {
  const res = await query<{
    stage: string; ok: number; failed: number; skipped: number; warning: number
  }>(
    `SELECT stage,
            COUNT(*) FILTER (WHERE outcome = 'ok')::int      AS ok,
            COUNT(*) FILTER (WHERE outcome = 'failed')::int  AS failed,
            COUNT(*) FILTER (WHERE outcome = 'skipped')::int AS skipped,
            COUNT(*) FILTER (WHERE outcome = 'warning')::int AS warning
       FROM run_stage_result WHERE run_id = $1 AND subject_id IS NOT NULL
      GROUP BY stage ORDER BY stage`,
    [runId])
  return res.rows
}
