/**
 * All SQL for the run ledger (E01-S05).
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'
import type { Run, RunKind, RunProgress, RunStatus, StageOutcome, StageResult } from '../types/runTypes.js'

interface RunRow {
  run_id: number
  kind: RunKind
  status: RunStatus
  params: Record<string, unknown>
  pinned_config: Record<string, unknown>
  correlation_id: string
  started_by: string | null
  started_at: Date
  finished_at: Date | null
  cost_usd: number
  error: string | null
}

const toRun = (r: RunRow): Run => ({
  runId: r.run_id,
  kind: r.kind,
  status: r.status,
  params: r.params,
  pinnedConfig: r.pinned_config,
  correlationId: r.correlation_id,
  startedBy: r.started_by,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  costUsd: Number(r.cost_usd),
  error: r.error,
})

const RUN_COLS = `run_id, kind, status, params, pinned_config, correlation_id,
                  started_by, started_at, finished_at, cost_usd, error`

export async function insertRun(input: {
  kind: RunKind
  params: Record<string, unknown>
  pinnedConfig: Record<string, unknown>
  correlationId: string
  startedBy: string | null
}, client?: DbClient): Promise<Run> {
  const row = await queryOne<RunRow>(
    `INSERT INTO run (kind, params, pinned_config, correlation_id, started_by, status)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, 'PENDING')
     RETURNING ${RUN_COLS}`,
    [input.kind, JSON.stringify(input.params), JSON.stringify(input.pinnedConfig),
     input.correlationId, input.startedBy],
    client,
  )
  if (!row) throw new Error('insertRun returned no row')
  return toRun(row)
}

export async function selectRun(runId: number): Promise<Run | null> {
  const row = await queryOne<RunRow>(`SELECT ${RUN_COLS} FROM run WHERE run_id = $1`, [runId])
  return row ? toRun(row) : null
}

export async function updateRunStatus(
  runId: number,
  status: RunStatus,
  error: string | null,
  client?: DbClient,
): Promise<Run | null> {
  const terminal = status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED'
  const row = await queryOne<RunRow>(
    `UPDATE run
        SET status = $2,
            error = COALESCE($3, error),
            finished_at = CASE WHEN $4 THEN now() ELSE finished_at END
      WHERE run_id = $1
      RETURNING ${RUN_COLS}`,
    [runId, status, error, terminal],
    client,
  )
  return row ? toRun(row) : null
}

/** Accumulate spend onto the run (E10-S03). Additive so concurrent workers cannot clobber. */
export async function addRunCost(runId: number, deltaUsd: number, client?: DbClient): Promise<number> {
  const row = await queryOne<{ cost_usd: number }>(
    `UPDATE run SET cost_usd = cost_usd + $2 WHERE run_id = $1 RETURNING cost_usd`,
    [runId, deltaUsd],
    client,
  )
  return Number(row?.cost_usd ?? 0)
}

export async function listRuns(limit: number, offset: number, kind?: RunKind): Promise<Run[]> {
  const res = kind
    ? await query<RunRow>(
        `SELECT ${RUN_COLS} FROM run WHERE kind = $3 ORDER BY started_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset, kind])
    : await query<RunRow>(
        `SELECT ${RUN_COLS} FROM run ORDER BY started_at DESC LIMIT $1 OFFSET $2`, [limit, offset])
  return res.rows.map(toRun)
}

/** Real backend count for pagination metadata (P5.7, P6.3). */
export async function countRuns(kind?: RunKind): Promise<number> {
  const row = kind
    ? await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM run WHERE kind = $1', [kind])
    : await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM run')
  return row?.n ?? 0
}

interface StageRow {
  id: number
  run_id: number
  stage: string
  subject_type: string
  subject_id: string | null
  outcome: StageOutcome
  message: string | null
  detail: Record<string, unknown>
  attempt: number
  started_at: Date
  finished_at: Date | null
  duration_ms: number | null
}

const toStage = (r: StageRow): StageResult => ({
  id: r.id, runId: r.run_id, stage: r.stage, subjectType: r.subject_type,
  subjectId: r.subject_id, outcome: r.outcome, message: r.message, detail: r.detail,
  attempt: r.attempt, startedAt: r.started_at, finishedAt: r.finished_at,
  durationMs: r.duration_ms,
})

/**
 * Record a stage outcome. Idempotent on (run, stage, subject, attempt) so a resumed run cannot
 * write duplicates (E10-S04 acceptance 3) — a re-record updates the existing row in place.
 */
export async function upsertStageResult(input: {
  runId: number
  stage: string
  subjectType: string
  subjectId: string | null
  outcome: StageOutcome
  message: string | null
  detail: Record<string, unknown>
  attempt: number
  durationMs: number | null
}, client?: DbClient): Promise<StageResult> {
  const row = await queryOne<StageRow>(
    `INSERT INTO run_stage_result
       (run_id, stage, subject_type, subject_id, outcome, message, detail, attempt,
        finished_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), $9)
     ON CONFLICT (run_id, stage, subject_type, COALESCE(subject_id, ''), attempt)
     DO UPDATE SET outcome = EXCLUDED.outcome, message = EXCLUDED.message,
                   detail = EXCLUDED.detail, finished_at = now(),
                   duration_ms = EXCLUDED.duration_ms
     RETURNING *`,
    [input.runId, input.stage, input.subjectType, input.subjectId, input.outcome,
     input.message, JSON.stringify(input.detail), input.attempt, input.durationMs],
    client,
  )
  if (!row) throw new Error('upsertStageResult returned no row')
  return toStage(row)
}

export async function selectStages(runId: number, limit = 1000): Promise<StageResult[]> {
  const res = await query<StageRow>(
    `SELECT * FROM run_stage_result WHERE run_id = $1
      ORDER BY started_at, id LIMIT $2`,
    [runId, limit],
  )
  return res.rows.map(toStage)
}

/** Subjects already completed for a stage — the basis for skip-on-resume (E10-S04). */
export async function selectCompletedSubjects(runId: number, stage: string): Promise<string[]> {
  const res = await query<{ subject_id: string }>(
    `SELECT DISTINCT subject_id FROM run_stage_result
      WHERE run_id = $1 AND stage = $2 AND outcome IN ('ok', 'skipped') AND subject_id IS NOT NULL`,
    [runId, stage],
  )
  return res.rows.map((r) => r.subject_id)
}

/** Reads the published progress view rather than re-aggregating (P1.3). */
export async function selectProgress(runId: number): Promise<RunProgress | null> {
  const row = await queryOne<{
    run_id: number; kind: RunKind; status: RunStatus; started_at: Date; finished_at: Date | null
    cost_usd: number; stage_results: number; ok_count: number; failed_count: number
    skipped_count: number; warning_count: number
  }>('SELECT * FROM v_platform_run_progress WHERE run_id = $1', [runId])
  if (!row) return null
  return {
    runId: row.run_id, kind: row.kind, status: row.status, startedAt: row.started_at,
    finishedAt: row.finished_at, costUsd: Number(row.cost_usd),
    stageResults: Number(row.stage_results), okCount: Number(row.ok_count),
    failedCount: Number(row.failed_count), skippedCount: Number(row.skipped_count),
    warningCount: Number(row.warning_count),
  }
}
