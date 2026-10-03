/**
 * Reads the caveat sources for flag generation (E08-S03 acceptance 1).
 *
 * Every query here goes through a published view (P1.3). Flag generation spans six modules'
 * worth of evidence, and importing six modules' tables would be exactly the cross-module
 * coupling the architecture forbids.
 */
import { query } from '../../../db/pool.js'

export interface ScanCoverage {
  submission_id: number
  files_analyzed: number
  files_total: number
  budget_truncated: boolean
}

export async function scanCoverageFor(submissionIds: readonly number[]): Promise<
  Map<number, ScanCoverage>
> {
  if (submissionIds.length === 0) return new Map()
  const res = await query<ScanCoverage>(
    `SELECT submission_id, files_analyzed, files_total, budget_truncated
       FROM v_scans_coverage WHERE submission_id = ANY($1)`,
    [submissionIds])
  return new Map(res.rows.map((r) => [r.submission_id, r]))
}

export interface ProbeSummary {
  submission_id: number
  outcome: string
  runs_grade: string
  grade_reason: string
  probe_id: number
  log_truncated: boolean
}

export async function probesFor(submissionIds: readonly number[]): Promise<
  Map<number, ProbeSummary>
> {
  if (submissionIds.length === 0) return new Map()
  const res = await query<ProbeSummary>(
    `SELECT submission_id, outcome, runs_grade, grade_reason, probe_id, log_truncated
       FROM v_probes_current WHERE submission_id = ANY($1)`,
    [submissionIds])
  return new Map(res.rows.map((r) => [r.submission_id, r]))
}

export interface ProvenanceForSubmission {
  flags: Array<{ code: string; message: string }>
  /** What a person concluded, once one has looked (E19-S03). */
  resolved: boolean
  resolutionReason: string | null
}

export async function provenanceFor(submissionIds: readonly number[]): Promise<
  Map<number, ProvenanceForSubmission>
> {
  if (submissionIds.length === 0) return new Map()
  const res = await query<{
    submission_id: number
    flags: Array<{ code: string; message: string }>
    resolved: boolean
    resolution_reason: string | null
  }>(
    `SELECT p.submission_id, p.flags,
            r.resolution_id IS NOT NULL AS resolved,
            r.reason AS resolution_reason
       FROM provenance p
       LEFT JOIN provenance_resolution r
              ON r.submission_id = p.submission_id AND r.withdrawn_at IS NULL
      WHERE p.submission_id = ANY($1)`,
    [submissionIds])
  return new Map(res.rows.map((r) => [r.submission_id, {
    flags: r.flags,
    resolved: r.resolved,
    resolutionReason: r.resolution_reason,
  }]))
}

/** Unscoreable criteria per submission, from the scoring module's published view. */
export async function nonScoresFor(runIndexId: number): Promise<
  Map<number, { insufficient: number; failed: number; total: number }>
> {
  const res = await query<{
    submission_id: number; insufficient: number; failed: number; total: number
  }>(
    `SELECT submission_id,
            COUNT(*) FILTER (WHERE non_score = 'INSUFFICIENT_EVIDENCE')::int AS insufficient,
            COUNT(*) FILTER (WHERE non_score = 'SCORING_FAILED')::int        AS failed,
            COUNT(*)::int                                                     AS total
       FROM v_scoring_criterion_scores WHERE run_index_id = $1
      GROUP BY submission_id`,
    [runIndexId])
  return new Map(res.rows.map((r) => [
    r.submission_id, { insufficient: r.insufficient, failed: r.failed, total: r.total },
  ]))
}

export async function varianceFor(cohortKey: string): Promise<
  Map<number, { delta: number; straddlesCut: boolean; threshold: number }>
> {
  const res = await query<{
    submission_id: number; delta: number; straddles_cut: boolean; threshold_used: number
  }>(
    `SELECT submission_id, delta, straddles_cut, threshold_used
       FROM score_variance WHERE cohort_key = $1`,
    [cohortKey])
  return new Map(res.rows.map((r) => [
    r.submission_id,
    { delta: Number(r.delta), straddlesCut: r.straddles_cut, threshold: Number(r.threshold_used) },
  ]))
}
