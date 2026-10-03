/**
 * All SQL for build probes (P1.2).
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'
import type { ProbeResult, RunsGrade, SandboxPolicy } from '@crucible/prober'

export interface ProbeRow {
  probe_id: number
  submission_id: number
  scan_id: number | null
  method: string
  outcome: string
  runs_grade: RunsGrade
  runs_score: number
  grade_reason: string
  exit_code: number | null
  build_duration_ms: number
  stayed_up: boolean
  run_duration_ms: number
  duration_ms: number
  timed_out: boolean
  resource_exceeded: boolean
  log: string
  log_truncated: boolean
  log_bytes: number
  base_image: string | null
  egress_allowed: string[]
  policy: SandboxPolicy
  probe_error: string | null
  run_id: number | null
  superseded_at: Date | null
  ran_at: Date
}

/** Everything except the log, which is fetched deliberately and audited (E05-S05). */
const COLS = `probe_id, submission_id, scan_id, method, outcome, runs_grade, runs_score,
  grade_reason, exit_code, build_duration_ms, stayed_up, run_duration_ms, duration_ms,
  timed_out, resource_exceeded, log_truncated, log_bytes, base_image, egress_allowed,
  policy, probe_error, run_id, superseded_at, ran_at`

export async function insertProbe(input: {
  submissionId: number
  scanId: number | null
  result: ProbeResult
  grade: { grade: RunsGrade; score: number; reason: string }
  policy: SandboxPolicy
  runId: number | null
}, client?: DbClient): Promise<Omit<ProbeRow, 'log'>> {
  const r = input.result
  const row = await queryOne<Omit<ProbeRow, 'log'>>(
    `INSERT INTO build_probe
       (submission_id, scan_id, method, outcome, runs_grade, runs_score, grade_reason,
        exit_code, build_duration_ms, stayed_up, run_duration_ms, duration_ms,
        timed_out, resource_exceeded, log, log_truncated, log_bytes,
        base_image, egress_allowed, policy, probe_error, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::text[],$20::jsonb,$21,$22)
     RETURNING ${COLS}`,
    [input.submissionId, input.scanId, r.method, r.outcome, input.grade.grade,
     input.grade.score, input.grade.reason, r.buildExitCode, r.buildDurationMs, r.stayedUp,
     r.runDurationMs, r.totalDurationMs, r.timedOut, r.resourceExceeded, r.log,
     r.logTruncated, r.logBytes, r.baseImage, r.egressAllowed, JSON.stringify(input.policy),
     r.probeError, input.runId],
    client)
  if (!row) throw new Error('insertProbe returned no row')
  return row
}

/** Stand a probe down so a re-probe can replace it. The old one is kept as evidence (P7.1). */
export async function supersedeProbe(probeId: number, client?: DbClient): Promise<void> {
  await query('UPDATE build_probe SET superseded_at = now() WHERE probe_id = $1', [probeId], client)
}

export async function selectCurrentProbe(submissionId: number): Promise<Omit<ProbeRow, 'log'> | null> {
  return queryOne<Omit<ProbeRow, 'log'>>(
    `SELECT ${COLS} FROM build_probe WHERE submission_id = $1 AND superseded_at IS NULL`,
    [submissionId])
}

export async function selectProbe(probeId: number): Promise<Omit<ProbeRow, 'log'> | null> {
  return queryOne<Omit<ProbeRow, 'log'>>(
    `SELECT ${COLS} FROM build_probe WHERE probe_id = $1`, [probeId])
}

/** The log, fetched separately so reading it is a distinct, auditable act (E05-S05). */
export async function selectProbeLog(probeId: number): Promise<{
  log: string; logTruncated: boolean; logBytes: number; submissionId: number
} | null> {
  const row = await queryOne<{
    log: string; log_truncated: boolean; log_bytes: number; submission_id: number
  }>(
    'SELECT log, log_truncated, log_bytes, submission_id FROM build_probe WHERE probe_id = $1',
    [probeId])
  if (!row) return null
  return {
    log: row.log, logTruncated: row.log_truncated,
    logBytes: row.log_bytes, submissionId: row.submission_id,
  }
}

export async function listProbes(limit: number, offset: number): Promise<Array<Omit<ProbeRow, 'log'>>> {
  const res = await query<Omit<ProbeRow, 'log'>>(
    `SELECT ${COLS} FROM build_probe WHERE superseded_at IS NULL
      ORDER BY ran_at DESC LIMIT $1 OFFSET $2`, [limit, offset])
  return res.rows
}

export async function countProbes(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM build_probe WHERE superseded_at IS NULL')
  return row?.n ?? 0
}

/** Outcome distribution across the cohort — what an operator watches during a run. */
export async function probeHealth(): Promise<Array<{ outcome: string; count: number }>> {
  const res = await query<{ outcome: string; count: number }>(
    'SELECT outcome, count FROM v_probes_health ORDER BY count DESC')
  return res.rows
}

/** The Runs dimension input, read from the published view (P1.3). */
export async function selectRunsInput(submissionId: number): Promise<{
  grade: RunsGrade; score: number; reason: string; probeId: number
} | null> {
  const row = await queryOne<{
    probe_id: number; runs_grade: RunsGrade; runs_score: number; grade_reason: string
  }>(
    `SELECT probe_id, runs_grade, runs_score, grade_reason
       FROM v_probes_current WHERE submission_id = $1`,
    [submissionId])
  if (!row) return null
  return {
    probeId: row.probe_id, grade: row.runs_grade,
    score: row.runs_score, reason: row.grade_reason,
  }
}
