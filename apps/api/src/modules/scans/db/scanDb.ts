/**
 * All SQL for scans and provenance (P1.2).
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'
import type { ScanResult } from '@crucible/scanner'

export interface ScanRow {
  scan_id: number
  submission_id: number
  commit_sha: string | null
  head_committed_at: Date | null
  depth: string
  files_analyzed: number
  files_total: number
  budget_truncated: boolean
  total_lines: number
  code_lines: number
  comment_lines: number
  languages: string[]
  has_tests: boolean
  test_file_count: number
  has_ci: boolean
  has_dockerfile: boolean
  has_readme: boolean
  dependency_count: number
  primary_language: string | null
  content_hash: string
  status: string
  error: string | null
  run_id: number | null
  started_at: Date
  finished_at: Date | null
  duration_ms: number | null
}

const COLS = `scan_id, submission_id, commit_sha, head_committed_at, depth,
  files_analyzed, files_total, budget_truncated, total_lines, code_lines, comment_lines,
  languages, has_tests, test_file_count, has_ci, has_dockerfile, has_readme,
  dependency_count, primary_language, content_hash, status, error, run_id,
  started_at, finished_at, duration_ms`

export async function insertScan(input: {
  submissionId: number
  result: ScanResult
  contentHash: string
  primaryLanguage: string | null
  runId: number | null
}, client?: DbClient): Promise<ScanRow> {
  const r = input.result
  const m = r.metrics

  const row = await queryOne<ScanRow>(
    `INSERT INTO scan
       (submission_id, commit_sha, head_committed_at, depth, files_analyzed, files_total,
        budget_truncated, total_lines, code_lines, comment_lines, languages, has_tests,
        test_file_count, has_ci, has_dockerfile, has_readme, dependency_count, primary_language,
        raw_result, content_hash, status, run_id, finished_at, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16,$17,$18,
             $19::jsonb,$20,'COMPLETED',$21, now(), $22)
     RETURNING ${COLS}`,
    [input.submissionId, r.commitSha, r.headCommittedAt, r.depth, r.filesAnalysed, r.filesTotal,
     r.budgetTruncated, m.totalLines, m.codeLines, m.commentLines, m.languages, m.hasTests,
     m.testFileCount, m.hasCi, m.hasDockerfile, m.hasReadme, m.dependencyCount,
     input.primaryLanguage, JSON.stringify(r), input.contentHash, input.runId, r.durationMs],
    client)
  if (!row) throw new Error('insertScan returned no row')
  return row
}

export async function insertFailedScan(input: {
  submissionId: number; depth: string; error: string; runId: number | null
}): Promise<ScanRow> {
  const row = await queryOne<ScanRow>(
    `INSERT INTO scan (submission_id, depth, raw_result, content_hash, status, error, run_id, finished_at)
     VALUES ($1, $2, '{}'::jsonb, repeat('0', 64), 'FAILED', $3, $4, now())
     RETURNING ${COLS}`,
    [input.submissionId, input.depth, input.error, input.runId])
  if (!row) throw new Error('insertFailedScan returned no row')
  return row
}

export async function selectScan(scanId: number): Promise<ScanRow | null> {
  return queryOne<ScanRow>(`SELECT ${COLS} FROM scan WHERE scan_id = $1`, [scanId])
}

/** The scanner's output verbatim — what scoring reads (E04-S05 acceptance 2). */
export async function selectRawResult(scanId: number): Promise<ScanResult | null> {
  const row = await queryOne<{ raw_result: ScanResult }>(
    'SELECT raw_result FROM scan WHERE scan_id = $1 AND status = $2', [scanId, 'COMPLETED'])
  return row?.raw_result ?? null
}

export async function selectLatestScan(submissionId: number): Promise<ScanRow | null> {
  return queryOne<ScanRow>(
    `SELECT ${COLS} FROM scan
      WHERE submission_id = $1 AND status = 'COMPLETED' AND superseded_at IS NULL
      ORDER BY finished_at DESC LIMIT 1`,
    [submissionId])
}

/**
 * Stand an existing scan down so a forced re-scan can take its place.
 *
 * The superseded row is kept, not deleted: a score may cite it, and an appeal needs to be able
 * to see exactly what was scanned (P7.1).
 */
export async function supersedeScan(
  scanId: number, replacedBy: number | null, client?: DbClient,
): Promise<void> {
  await query(
    'UPDATE scan SET superseded_at = now(), superseded_by = $2 WHERE scan_id = $1',
    [scanId, replacedBy], client)
}

/** An existing completed scan at this exact commit, if any (E04-S03 acceptance 3). */
export async function selectScanAtCommit(
  submissionId: number, commitSha: string,
): Promise<ScanRow | null> {
  return queryOne<ScanRow>(
    `SELECT ${COLS} FROM scan
      WHERE submission_id = $1 AND commit_sha = $2 AND status = 'COMPLETED'
        AND superseded_at IS NULL`,
    [submissionId, commitSha])
}

export async function listScans(limit: number, offset: number): Promise<ScanRow[]> {
  const res = await query<ScanRow>(
    `SELECT ${COLS} FROM scan ORDER BY started_at DESC LIMIT $1 OFFSET $2`, [limit, offset])
  return res.rows
}

export async function countScans(): Promise<number> {
  const row = await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM scan')
  return row?.n ?? 0
}

export interface ProvenanceRow {
  submission_id: number
  scan_id: number
  first_commit_at: Date | null
  last_commit_at: Date | null
  total_commits: number
  commits_in_window: number
  commits_out_of_window: number
  distinct_authors: number
  authors: string[]
  largest_single_commit_pct: number
  history_truncated: boolean
  flags: Array<{ code: string; message: string }>
  analysed_at: Date
  /** Set once a person has looked and recorded what they concluded (E19-S03). */
  resolved?: boolean
  resolution_reason?: string | null
  resolved_by?: string | null
}

export async function upsertProvenance(input: {
  submissionId: number
  scanId: number
  provenance: NonNullable<ScanResult['provenance']>
  flags: Array<{ code: string; message: string }>
}, client?: DbClient): Promise<ProvenanceRow> {
  const p = input.provenance
  const row = await queryOne<ProvenanceRow>(
    `INSERT INTO provenance
       (submission_id, scan_id, first_commit_at, last_commit_at, total_commits,
        commits_in_window, commits_out_of_window, distinct_authors, authors,
        largest_single_commit_pct, history_truncated, flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12::jsonb)
     ON CONFLICT (submission_id) DO UPDATE SET
       scan_id = EXCLUDED.scan_id,
       first_commit_at = EXCLUDED.first_commit_at,
       last_commit_at = EXCLUDED.last_commit_at,
       total_commits = EXCLUDED.total_commits,
       commits_in_window = EXCLUDED.commits_in_window,
       commits_out_of_window = EXCLUDED.commits_out_of_window,
       distinct_authors = EXCLUDED.distinct_authors,
       authors = EXCLUDED.authors,
       largest_single_commit_pct = EXCLUDED.largest_single_commit_pct,
       history_truncated = EXCLUDED.history_truncated,
       flags = EXCLUDED.flags,
       analysed_at = now()
     RETURNING *`,
    [input.submissionId, input.scanId, p.firstCommitAt, p.lastCommitAt, p.totalCommits,
     p.commitsInWindow, p.commitsOutOfWindow, p.distinctAuthors, p.authors,
     p.largestSingleCommitPct, p.historyTruncated, JSON.stringify(input.flags)],
    client)
  if (!row) throw new Error('upsertProvenance returned no row')
  return row
}

export async function selectProvenance(submissionId: number): Promise<ProvenanceRow | null> {
  return queryOne<ProvenanceRow>(
    'SELECT * FROM provenance WHERE submission_id = $1', [submissionId])
}

/**
 * The queue an operator works through.
 *
 * Unresolved first, then by how concentrated the history is. A resolved entry stays in the list
 * rather than vanishing: a reader must be able to tell "a person looked and was satisfied" from
 * "nobody has looked yet" (E19-S03).
 */
export async function selectFlaggedProvenance(): Promise<ProvenanceRow[]> {
  const res = await query<ProvenanceRow>(
    `SELECT * FROM v_provenance_queue
      ORDER BY resolved, largest_single_commit_pct DESC`)
  return res.rows
}

/**
 * Record what a person concluded about a flagged history.
 *
 * Records a conclusion; it does not remove anything. E04-S06 is explicit that provenance
 * produces FLAGS, never exclusions, and there is deliberately no path here that could.
 */
export async function resolveProvenance(input: {
  submissionId: number; reason: string; actor: string
}): Promise<void> {
  await query(
    `INSERT INTO provenance_resolution (submission_id, reason, resolved_by)
     VALUES ($1, $2, $3)`,
    [input.submissionId, input.reason, input.actor])
}

export interface CoverageRow {
  submission_id: number
  files_analyzed: number
  files_total: number
  budget_truncated: boolean
  coverage_pct: number
}

/** Reads the published view (P1.3) — used by E08-S06 to label truncated scans. */
export async function selectCoverage(): Promise<CoverageRow[]> {
  const res = await query<CoverageRow>('SELECT * FROM v_scans_coverage ORDER BY coverage_pct')
  return res.rows
}
