/**
 * SQL for repository discovery (E12).
 */
import { query, queryOne, tx } from '../../../db/pool.js'

export interface DiscoveryRunRow {
  discovery_id: number
  submission_id: number
  scan_id: number
  commit_sha: string | null
  status: string
  concerns: Record<string, { outcome: string; count: number; note?: string }>
  model: string | null
  cost_usd: number
  started_at: Date
  finished_at: Date | null
  error: string | null
}

export interface FindingRow {
  finding_id?: number
  discovery_id: number
  submission_id: number
  kind: string
  label: string
  summary: string
  detail: Record<string, unknown>
  path: string
  line_start: number | null
  line_end: number | null
  excerpt: string
  confidence: string
  /** Whether a reviewer has checked this and set it aside (E16-S03). */
  dismissed?: boolean
  dismissal_reason?: string | null
  dismissed_by?: string | null
}

export interface ConflictRow {
  conflict_id: number
  submission_id: number
  claim: string
  claim_path: string
  claim_line: number | null
  expected: string
  observed: string
  confidence: string
}

/**
 * Open a run, standing any previous one down.
 *
 * Supersede rather than replace: a superseded run keeps its findings, so a decision taken while
 * an older description was on screen remains explicable.
 */
export async function openDiscovery(input: {
  submissionId: number
  scanId: number
  commitSha: string | null
  ledgerRunId: number | null
  startedBy: string
}): Promise<DiscoveryRunRow> {
  return tx(async (client) => {
    // The old run stands down BEFORE the new one is inserted. `uq_discovery_current` is a plain
    // partial unique index, not a deferred constraint, so it fires the moment a second row with
    // `superseded_at IS NULL` exists — inserting first and superseding after fails on the second
    // discovery of any submission.
    const previous = await queryOne<{ discovery_id: number }>(
      `UPDATE discovery_run SET superseded_at = now()
        WHERE submission_id = $1 AND superseded_at IS NULL
        RETURNING discovery_id`,
      [input.submissionId], client)

    const row = await queryOne<DiscoveryRunRow>(
      `INSERT INTO discovery_run
         (submission_id, scan_id, commit_sha, ledger_run_id, started_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.submissionId, input.scanId, input.commitSha,
       input.ledgerRunId, input.startedBy], client)
    if (!row) throw new Error('openDiscovery returned no row')

    // Which run replaced it, so a superseded description can be read forward to its successor.
    if (previous) {
      await client.query(
        'UPDATE discovery_run SET superseded_by = $2 WHERE discovery_id = $1',
        [previous.discovery_id, row.discovery_id])
    }
    return row
  })
}

export async function finishDiscovery(input: {
  discoveryId: number
  status: string
  concerns: Record<string, unknown>
  model: string | null
  costUsd: number
  error: string | null
}): Promise<void> {
  await query(
    `UPDATE discovery_run SET status = $2, concerns = $3::jsonb, model = $4,
            cost_usd = $5, error = $6, finished_at = now()
      WHERE discovery_id = $1`,
    [input.discoveryId, input.status, JSON.stringify(input.concerns),
     input.model, input.costUsd, input.error])
}

export async function insertFindings(
  discoveryId: number, submissionId: number,
  findings: ReadonlyArray<Omit<FindingRow, 'discovery_id' | 'submission_id'>>,
): Promise<void> {
  if (findings.length === 0) return
  await tx(async (client) => {
    for (const f of findings) {
      await client.query(
        `INSERT INTO discovery_finding
           (discovery_id, submission_id, kind, label, summary, detail,
            path, line_start, line_end, excerpt, confidence)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
        [discoveryId, submissionId, f.kind, f.label, f.summary, JSON.stringify(f.detail),
         f.path, f.line_start, f.line_end, f.excerpt, f.confidence])
    }
  })
}

export async function insertConflicts(
  discoveryId: number, submissionId: number,
  conflicts: ReadonlyArray<Omit<ConflictRow, 'conflict_id' | 'submission_id'>>,
): Promise<void> {
  if (conflicts.length === 0) return
  for (const c of conflicts) {
    await query(
      `INSERT INTO discovery_claim_conflict
         (discovery_id, submission_id, claim, claim_path, claim_line,
          expected, observed, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [discoveryId, submissionId, c.claim, c.claim_path, c.claim_line,
       c.expected, c.observed, c.confidence])
  }
}

export async function currentDiscovery(submissionId: number): Promise<DiscoveryRunRow | null> {
  return queryOne<DiscoveryRunRow>(
    'SELECT * FROM v_discovery_current WHERE submission_id = $1', [submissionId])
}

export async function findingsFor(
  submissionId: number, kind?: string,
): Promise<FindingRow[]> {
  const res = await query<FindingRow>(
    `SELECT * FROM v_discovery_findings_reviewed
      WHERE submission_id = $1 AND ($2::text IS NULL OR kind = $2)
      ORDER BY kind, confidence DESC, label`,
    [submissionId, kind ?? null])
  return res.rows
}

/**
 * Set an observation aside, with a reason.
 *
 * Supersede rather than delete, and the reason is enforced by the table rather than here: the
 * pattern `review_flag` already uses, at the level the next caller cannot work around.
 */
export async function dismissFinding(input: {
  findingId: number
  reason: string
  actor: string
}): Promise<{ submissionId: number }> {
  const row = await queryOne<{ submission_id: number }>(
    `INSERT INTO discovery_dismissal (finding_id, submission_id, reason, dismissed_by)
     SELECT f.finding_id, f.submission_id, $2, $3
       FROM discovery_finding f WHERE f.finding_id = $1
     RETURNING submission_id`,
    [input.findingId, input.reason, input.actor])
  if (!row) throw new Error(`discovery finding ${input.findingId} was not found`)
  return { submissionId: Number(row.submission_id) }
}

/** Reinstate an observation. Itself a decision, so the withdrawn dismissal is kept. */
export async function reinstateFinding(findingId: number, actor: string): Promise<boolean> {
  const res = await query(
    `UPDATE discovery_dismissal SET withdrawn_at = now(), withdrawn_by = $2
      WHERE finding_id = $1 AND withdrawn_at IS NULL`,
    [findingId, actor])
  return (res.rowCount ?? 0) > 0
}

export async function conflictsFor(submissionId: number): Promise<ConflictRow[]> {
  const res = await query<ConflictRow>(
    `SELECT c.* FROM discovery_claim_conflict c
       JOIN discovery_run dr ON dr.discovery_id = c.discovery_id
      WHERE c.submission_id = $1 AND dr.superseded_at IS NULL
      ORDER BY c.confidence DESC`,
    [submissionId])
  return res.rows
}

/** Counts per kind — what the summary tiles show, as a real count (E08-S06). */
export async function findingCounts(submissionId: number): Promise<Record<string, number>> {
  const res = await query<{ kind: string; n: number }>(
    `SELECT kind, COUNT(*)::int AS n FROM v_discovery_findings
      WHERE submission_id = $1 GROUP BY kind`,
    [submissionId])
  return Object.fromEntries(res.rows.map((r) => [r.kind, r.n]))
}

/**
 * Findings still awaiting a look, per kind.
 *
 * Separate from the total on purpose: the tile shows how many were FOUND, which does not change
 * when a reviewer checks one, while the warning should stop once nothing is left to check.
 */
export async function openFindingCounts(submissionId: number): Promise<Record<string, number>> {
  const res = await query<{ kind: string; n: number }>(
    `SELECT kind, COUNT(*)::int AS n FROM v_discovery_findings_reviewed
      WHERE submission_id = $1 AND NOT dismissed GROUP BY kind`,
    [submissionId])
  return Object.fromEntries(res.rows.map((r) => [r.kind, r.n]))
}
