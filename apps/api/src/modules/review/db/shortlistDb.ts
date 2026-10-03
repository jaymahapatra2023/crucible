/**
 * SQL for shortlist decisions (E08-S04, E08-S05).
 */
import { query, queryOne, tx } from '../../../db/pool.js'

export interface ShortlistRow {
  shortlist_id: number
  run_index_id: number
  name: string
  status: string
  rubric_versions: Record<string, number>
  finalised_at: Date | null
  finalised_by: string | null
  created_by: string | null
  created_at: Date
}

export async function upsertShortlist(input: {
  runIndexId: number
  name: string
  createdBy: string
}): Promise<ShortlistRow> {
  const row = await queryOne<ShortlistRow>(
    `INSERT INTO shortlist (run_index_id, name, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (run_index_id) DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name, ''), shortlist.name)
     RETURNING *`,
    [input.runIndexId, input.name, input.createdBy])
  if (!row) throw new Error('upsertShortlist returned no row')
  return row
}

export async function selectShortlist(runIndexId: number): Promise<ShortlistRow | null> {
  return queryOne<ShortlistRow>(
    'SELECT * FROM shortlist WHERE run_index_id = $1', [runIndexId])
}

export async function finaliseShortlist(input: {
  shortlistId: number
  actor: string
  rubricVersions: Record<string, number>
}): Promise<ShortlistRow | null> {
  return queryOne<ShortlistRow>(
    `UPDATE shortlist
        SET status = 'FINAL', finalised_at = now(), finalised_by = $2,
            rubric_versions = $3::jsonb
      WHERE shortlist_id = $1 AND status = 'OPEN'
      RETURNING *`,
    [input.shortlistId, input.actor, JSON.stringify(input.rubricVersions)])
}

/**
 * Reopen a finalised shortlist.
 *
 * Deliberately available, and deliberately audited by the caller. A shortlist that can never be
 * reopened invites the real fix to happen outside the system — in a spreadsheet nobody can
 * appeal against. Reopening is a recorded act; the decisions it unlocks keep their history.
 */
export async function reopenShortlist(shortlistId: number): Promise<ShortlistRow | null> {
  return queryOne<ShortlistRow>(
    `UPDATE shortlist
        SET status = 'OPEN', finalised_at = NULL, finalised_by = NULL
      WHERE shortlist_id = $1 AND status = 'FINAL'
      RETURNING *`,
    [shortlistId])
}

export interface DecisionRow {
  shortlist_id: number
  run_index_id: number
  shortlist_status: string
  submission_id: number
  decision: string
  reason: string
  decided_by: string
  decided_at: Date
  rank_at_decision: number | null
}

/**
 * Record a decision, standing the previous one down rather than overwriting it (P7.1).
 *
 * Superseded FIRST, then inserted. The partial unique index permits one standing decision per
 * submission, so inserting first collides with the row it replaces — the same ordering the
 * submission chain and the discovery runs use, and for the same reason.
 */
export async function recordDecision(input: {
  shortlistId: number
  submissionId: number
  decision: string
  reason: string
  actor: string
  rankAtDecision: number | null
}): Promise<void> {
  await tx(async (client) => {
    const previous = await queryOne<{ id: number }>(
      `UPDATE shortlist_decision SET superseded_at = now()
        WHERE shortlist_id = $1 AND submission_id = $2 AND superseded_at IS NULL
        RETURNING id`,
      [input.shortlistId, input.submissionId], client)

    const created = await queryOne<{ id: number }>(
      `INSERT INTO shortlist_decision
         (shortlist_id, submission_id, decision, reason, decided_by, rank_at_decision)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.shortlistId, input.submissionId, input.decision, input.reason,
       input.actor, input.rankAtDecision], client)

    if (previous && created) {
      await query(
        'UPDATE shortlist_decision SET superseded_by = $2 WHERE id = $1',
        [previous.id, created.id], client)
    }
  })
}

export interface DecisionHistoryRow {
  id: number
  decision: string
  reason: string
  decided_by: string
  decided_at: Date
  rank_at_decision: number | null
  superseded_at: Date | null
}

/**
 * Every decision ever taken about one team, newest first.
 *
 * The standing one is the row with no `superseded_at`. An appeal asks what was decided and by
 * whom at each step, which is a different question from what stands now.
 */
export async function selectDecisionHistory(
  runIndexId: number, submissionId: number,
): Promise<DecisionHistoryRow[]> {
  const res = await query<DecisionHistoryRow>(
    `SELECT sd.id, sd.decision, sd.reason, sd.decided_by, sd.decided_at,
            sd.rank_at_decision, sd.superseded_at
       FROM shortlist_decision sd
       JOIN shortlist s ON s.shortlist_id = sd.shortlist_id
      WHERE s.run_index_id = $1 AND sd.submission_id = $2
      ORDER BY sd.decided_at DESC, sd.id DESC`,
    [runIndexId, submissionId])
  return res.rows
}

export async function selectDecisions(runIndexId: number): Promise<DecisionRow[]> {
  const res = await query<DecisionRow>(
    `SELECT * FROM v_shortlist_decisions WHERE run_index_id = $1 ORDER BY submission_id`,
    [runIndexId])
  return res.rows
}

/** Real backend counts per decision (E08-S01 acceptance 4, E08-S06 acceptance 1). */
export async function decisionCounts(runIndexId: number): Promise<Record<string, number>> {
  const res = await query<{ decision: string; n: number }>(
    `SELECT decision, COUNT(*)::int AS n FROM v_shortlist_decisions
      WHERE run_index_id = $1 GROUP BY decision`,
    [runIndexId])
  const counts: Record<string, number> = { SHORTLIST: 0, EXCLUDE: 0, HOLD: 0 }
  for (const row of res.rows) counts[row.decision] = row.n
  return counts
}

export interface BlockingItem {
  submission_id: number
  rank_global: number
  state: string
  open_flags: number
}

/**
 * Cut-band submissions that are not ready for the shortlist to be locked.
 *
 * Three states block, and they are different failures:
 *
 *  - **UNDECIDED** — nobody looked.
 *  - **HOLD** — somebody looked and did not decide.
 *  - **FLAGS_UNREVIEWED** — a decision exists, but a caveat the system raised about this
 *    submission has not been answered. The system-level definition of done is explicit that
 *    "every flag in the cut band was reviewed by a person and the review recorded"; a decision
 *    taken without reading the caveats is exactly the unexamined acceptance E08-S03 exists to
 *    prevent.
 */
export async function unresolvedInBand(runIndexId: number): Promise<BlockingItem[]> {
  const res = await query<BlockingItem>(
    `SELECT sc.submission_id,
            sc.rank_global,
            CASE
              WHEN sd.decision IS NULL     THEN 'UNDECIDED'
              WHEN sd.decision = 'HOLD'    THEN 'HOLD'
              ELSE 'FLAGS_UNREVIEWED'
            END AS state,
            COALESCE(f.open_flags, 0) AS open_flags
       FROM submission_composite sc
       LEFT JOIN v_shortlist_decisions sd
         ON sd.run_index_id = sc.run_index_id AND sd.submission_id = sc.submission_id
       LEFT JOIN (
         SELECT run_index_id, submission_id, COUNT(*)::int AS open_flags
           FROM v_review_flags WHERE NOT dismissed
          GROUP BY run_index_id, submission_id
       ) f ON f.run_index_id = sc.run_index_id AND f.submission_id = sc.submission_id
      WHERE sc.run_index_id = $1 AND sc.in_cut_band
        AND (sd.decision IS NULL
             OR sd.decision = 'HOLD'
             OR COALESCE(f.open_flags, 0) > 0)
      ORDER BY sc.rank_global`,
    [runIndexId])
  return res.rows
}
