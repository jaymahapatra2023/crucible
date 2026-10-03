/**
 * SQL for the golden set, calibration reports and the gate (E11).
 */
import { query, queryOne } from '../../../db/pool.js'

export interface GoldenSetRow {
  golden_set_id: number
  name: string
  description: string
  status: string
  sealed_at: Date | null
  sealed_by: string | null
  created_by: string | null
  created_at: Date
}

export interface GoldenEntryRow {
  entry_id: number
  golden_set_id: number
  label: string
  repo_url: string
  expected_band: string
  edge_case: string | null
  notes: string
  submission_id: number | null
}

export interface RankingRow {
  entry_id: number
  ranker: string
  position: number
  rationale: string
}

export async function insertGoldenSet(input: {
  name: string; description: string; createdBy: string
}): Promise<GoldenSetRow> {
  const row = await queryOne<GoldenSetRow>(
    `INSERT INTO golden_set (name, description, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [input.name, input.description, input.createdBy])
  if (!row) throw new Error('insertGoldenSet returned no row')
  return row
}

export async function selectGoldenSet(goldenSetId: number): Promise<GoldenSetRow | null> {
  return queryOne<GoldenSetRow>(
    'SELECT * FROM golden_set WHERE golden_set_id = $1', [goldenSetId])
}

export async function listGoldenSets(): Promise<GoldenSetRow[]> {
  const res = await query<GoldenSetRow>('SELECT * FROM golden_set ORDER BY created_at DESC')
  return res.rows
}

export async function insertEntry(input: {
  goldenSetId: number; label: string; repoUrl: string
  expectedBand: string; edgeCase: string | null; notes: string
}): Promise<GoldenEntryRow> {
  const row = await queryOne<GoldenEntryRow>(
    `INSERT INTO golden_entry
       (golden_set_id, label, repo_url, expected_band, edge_case, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.goldenSetId, input.label, input.repoUrl,
     input.expectedBand, input.edgeCase, input.notes])
  if (!row) throw new Error('insertEntry returned no row')
  return row
}

export async function selectEntries(goldenSetId: number): Promise<GoldenEntryRow[]> {
  const res = await query<GoldenEntryRow>(
    'SELECT * FROM golden_entry WHERE golden_set_id = $1 ORDER BY label', [goldenSetId])
  return res.rows
}

/**
 * Record which submission an entry was scored as.
 *
 * Permitted on a sealed set, and only this column is: sealing fixes the human judgement, and
 * scoring necessarily happens afterwards. Migration 043 makes that distinction in the trigger,
 * so the sealed state stays usable without becoming editable.
 */
export async function linkSubmission(
  entryId: number, submissionId: number | null,
): Promise<void> {
  await query(
    'UPDATE golden_entry SET submission_id = $2 WHERE entry_id = $1', [entryId, submissionId])
}

export async function insertRanking(input: {
  goldenSetId: number; entryId: number; ranker: string; position: number; rationale: string
}): Promise<void> {
  await query(
    `INSERT INTO golden_ranking (golden_set_id, entry_id, ranker, position, rationale)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (golden_set_id, ranker, entry_id) DO UPDATE SET
       position = EXCLUDED.position, rationale = EXCLUDED.rationale, submitted_at = now()`,
    [input.goldenSetId, input.entryId, input.ranker, input.position, input.rationale])
}

export async function selectRankings(
  goldenSetId: number, ranker?: string,
): Promise<RankingRow[]> {
  const res = await query<RankingRow>(
    `SELECT entry_id, ranker, position, rationale FROM golden_ranking
      WHERE golden_set_id = $1 AND ($2::text IS NULL OR ranker = $2)
      ORDER BY ranker, position`,
    [goldenSetId, ranker ?? null])
  return res.rows
}

export async function distinctRankers(goldenSetId: number): Promise<string[]> {
  const res = await query<{ ranker: string }>(
    'SELECT DISTINCT ranker FROM golden_ranking WHERE golden_set_id = $1 ORDER BY 1',
    [goldenSetId])
  return res.rows.map((r) => r.ranker)
}

export async function sealGoldenSet(
  goldenSetId: number, actor: string,
): Promise<GoldenSetRow | null> {
  return queryOne<GoldenSetRow>(
    `UPDATE golden_set SET status = 'SEALED', sealed_at = now(), sealed_by = $2
      WHERE golden_set_id = $1 AND status = 'OPEN' RETURNING *`,
    [goldenSetId, actor])
}

/**
 * Every current submission and the repository it points at, through the published view (P1.3).
 *
 * Whole rather than filtered by URL on purpose. A submission that has not validated yet still
 * holds whatever was pasted rather than the canonical clone URL, so matching in SQL would only
 * find the ones that happened to be typed in the normal form. Both sides are canonicalised in
 * the service instead, where there is one definition of it.
 *
 * `challengeId` narrows the candidates to one challenge. The same repository legitimately
 * appears under two challenges — a golden set rebuilt against a revised rubric is exactly that
 * case — and then a URL identifies a repository but not which submission of it is meant.
 *
 * Bounded (P5.7). A cohort is hundreds of entries at most, and a set this does not cover is one
 * where the count itself is the thing to look at.
 */
export async function selectCurrentSubmissionRepos(
  challengeId?: number, limit = 2000,
): Promise<Array<{ submissionId: number; teamName: string; repoUrl: string }>> {
  const res = await query<{ submission_id: number; team_name: string; repo_url: string }>(
    `SELECT submission_id, team_name, repo_url FROM v_submissions_submission
      WHERE ($1::bigint IS NULL OR challenge_id = $1)
      ORDER BY submission_id LIMIT $2`, [challengeId ?? null, limit])
  return res.rows.map((r) => ({
    submissionId: Number(r.submission_id), teamName: r.team_name, repoUrl: r.repo_url,
  }))
}
