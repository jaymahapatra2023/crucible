/**
 * All SQL for self-service participant corrections (P1.2, migration 104).
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'

export type CorrectionStatus = 'PENDING' | 'APPLIED' | 'REJECTED'

export interface Correction {
  correctionId: number
  claimedName: string
  claimedEmail: string
  participantId: number | null
  currentName: string | null
  currentEmail: string | null
  organisation: string | null
  matched: boolean
  /**
   * What approving would do. Derived from the match rather than stored, so it cannot drift from
   * it: ADD when nobody of that name is on the list, CORRECTION when exactly one person is.
   */
  kind: 'ADD' | 'CORRECTION'
  onATeam: boolean
  status: CorrectionStatus
  createdAt: Date
}

interface Row {
  correction_id: number; claimed_name: string; claimed_email: string
  participant_id: number | null; current_name: string | null; current_email: string | null
  organisation: string | null; matched: boolean; on_a_team: boolean
  status: CorrectionStatus; created_at: Date
}

const toCorrection = (r: Row): Correction => ({
  correctionId: Number(r.correction_id),
  claimedName: r.claimed_name, claimedEmail: r.claimed_email,
  participantId: r.participant_id === null ? null : Number(r.participant_id),
  currentName: r.current_name, currentEmail: r.current_email,
  organisation: r.organisation, matched: r.matched,
  kind: r.matched ? 'CORRECTION' : 'ADD',
  onATeam: r.on_a_team,
  status: r.status, createdAt: r.created_at,
})

/**
 * The participant whose name matches, by the database's own normalisation.
 *
 * Returns a match only when EXACTLY one person has that name. Two people called the same thing
 * is a case an organiser must look at, not one a public form may guess at — picking either would
 * be a coin toss over whose email gets rewritten.
 */
export async function selectByNormalisedName(fullName: string): Promise<{
  participantId: number; fullName: string; email: string
} | null> {
  const res = await query<{ participant_id: number; full_name: string; email: string }>(
    `SELECT participant_id, full_name, email FROM participant
      WHERE deleted_at IS NULL AND person_normalise(full_name) = person_normalise($1)
      LIMIT 2`, [fullName])
  if (res.rows.length !== 1) return null
  const row = res.rows[0]!
  return {
    participantId: Number(row.participant_id), fullName: row.full_name, email: row.email,
  }
}

export async function insertCorrection(input: {
  claimedName: string; claimedEmail: string
  participantId: number | null
  previousName: string | null; previousEmail: string | null
}): Promise<number> {
  const row = await queryOne<{ correction_id: number }>(
    `INSERT INTO participant_correction
       (claimed_name, claimed_email, participant_id, previous_name, previous_email)
     VALUES ($1,$2,$3,$4,$5) RETURNING correction_id`,
    [input.claimedName, input.claimedEmail, input.participantId,
     input.previousName, input.previousEmail])
  if (!row) throw new Error('insertCorrection returned no row')
  return Number(row.correction_id)
}

export async function listCorrections(status?: CorrectionStatus): Promise<Correction[]> {
  const res = status === undefined
    ? await query<Row>('SELECT * FROM v_roster_correction')
    : await query<Row>('SELECT * FROM v_roster_correction WHERE status = $1', [status])
  return res.rows.map(toCorrection)
}

export async function selectCorrection(correctionId: number): Promise<Correction | null> {
  const row = await queryOne<Row>(
    'SELECT * FROM v_roster_correction WHERE correction_id = $1', [correctionId])
  return row ? toCorrection(row) : null
}

/**
 * Mark one decided.
 *
 * `WHERE status = 'PENDING'` makes this the single-decision guarantee: two organisers pressing
 * at once both reach here and only the one whose UPDATE touches a row proceeds, so a correction
 * cannot be applied twice.
 */
export async function decideCorrection(input: {
  correctionId: number; status: 'APPLIED' | 'REJECTED'; actor: string
}, client?: DbClient): Promise<boolean> {
  const res = await query(
    `UPDATE participant_correction
        SET status = $2, decided_by = $3, decided_at = now()
      WHERE correction_id = $1 AND status = 'PENDING'`,
    [input.correctionId, input.status, input.actor], client)
  return (res.rowCount ?? 0) > 0
}
